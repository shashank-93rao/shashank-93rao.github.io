---
title: "Let's dive into Bigtable"
date: 2024-09-06T10:54:51+05:30
draft: false
tags: 
 - GCP
 - Databases
---

Bigtable is a super fast, distributed storage system built to handle loads of structured data—think petabytes worth—while keeping things quick and responsive. It's the engine behind many Google products you know and love, like Google Analytics and Google Earth.

In this post, I'll break down the key points from the original Google Bigtable paper. If you're up for some deeper reading, I've linked the full paper at the end—definitely worth a look!


## The Data Model

Under the hood, Bigtable's data model treats everything like a multi-dimensional sorted map. Data gets stored in cells that are indexed by three things: a row key, a column key, and a timestamp. The timestamp helps version the data, so you can see what was stored at different times. You can set this timestamp yourself, or let Bigtable handle it automatically when you insert data. It's important to note that the data itself is immutable—once it's set, any update you make is actually a new insertion with a more recent timestamp. Older versions of cells are regularly cleaned up (garbage collected) based on the settings you configure.

```
                                             +---------+---------+---------+
                                            / r1c1t3  / r1c2t3  / r1c3t3  /|
                                           +---------+---------+---------+ |
                                         / r1c1t2  / r1c2t2  / r1c3t2  /| +
                                        +---------+---------+---------+ |/|
                                      /         /         /         /| + |
             key                     +---------+---------+---------+ |/| +
            (r1,c1,t1)--------->     | r1c1t1  | r1c2t1  | r1c3t1  | + |/
                                     +---------+---------+---------+ |/
                                     | r2c1t1  | r2c2t1  | r2c3t1  | + 
                                     +---------+---------+---------+

```

The row key in Bigtable can be any string you like, but it’s got a size cap of 64KB. When it comes to reading or writing data, Bigtable guarantees atomicity at the row level, no matter how many columns you're dealing with. It also keeps all the data neatly sorted by row key. A range of rows is called a "tablet", and the size of each tablet is dynamically decided. Tablets are the smallest chunks Bigtable uses to distribute data. So, if your query sticks to a small range, it’ll likely perform faster since the data will either be in the same tablet or spread across just a few tablets.

Now, let's talk about columns. Column keys are grouped into what's called "column families". These column families are the smallest unit of access control in Bigtable, and you refer to any column using `family-name:column-name`.

## Building Blocks
Behind the scenes, Bigtable stores its data in the Google File System (GFS), which is a super scalable, distributed file system. The data itself gets stored in Sorted String Tables, or SSTables. You can think of an SSTable as a sorted map that's been written to a file. These tables hold keys and their corresponding values in order and are immutable, meaning they can’t be changed once written. SSTables are broken up into blocks, with each block covering a specific range of keys. The last block is an index that maps the range of keys to their exact byte positions within the file. When Bigtable opens an SSTable, it loads this index into memory, allowing it to find the location of any key quickly using a binary search. If you're interested in learning more about SSTables and LSM trees, check out the very famous book *Designing Data-Intensive Applications by Martin Kleppmann*.

Bigtable also relies on a distributed and highly available lock service called Chubby. Chubby provides directories and files that can be used as locks, and each operation on these files is atomic—meaning it either happens completely or not at all. Every Chubby client has a session that needs to be renewed periodically before it expires; if it doesn't, the lock is released, and another client can grab it.

## Tablet and Data Management

### Tablet Location
As I mentioned earlier, Bigtable stores data in units called tablets, and there are three types: root tablets, metadata tablets, and user tablets. These tablets are loaded and managed by tablet servers, which handle all the read and write requests for them.

The file location of the root tablet is stored in Chubby, and it has a unique property: it never gets split. The root tablet holds the location of the metadata tablet files and also serves as the first metadata tablet (known as metadata tablet 0). Together, all the metadata tablets form the metadata table.

Metadata tablet files, in turn, contain the locations of the user tablet data files. The row key in a metadata tablet is made of the table identifier and last row of the tablet.

Finally, the user tablets hold the actual SSTables and Write-Ahead Log (WAL) files where the user data is stored.

![Tablets and Tablet Assignment](/images/bigtable-tablets.png)


### Tablet Assignment
The master server in Bigtable plays a key role in managing the system. It's in charge of assigning tablets to tablet servers and keeping track of which server handles which tablet. If a tablet isn’t assigned to any server, the master steps in and assigns it to an available server. To keep tabs on live tablet servers, Bigtable uses Chubby. Each tablet server maintains an exclusive lock on a file in a specific directory in Chubby, and Bigtable watches this directory to see which servers are active. If a network issue occurs and a tablet server loses its exclusive lock, the server shuts itself down. Similarly, if a server is taken down for cluster management, it releases its lock.

The master server also routinely checks the health of each tablet server. If a server keeps failing these health checks or reports that it has lost its lock, the master server tries to grab the server's lock. If it succeeds, it means the tablet server is out of the picture and won't be serving any more tablet requests. The master quickly reassigns the tablets from the failed server to another one that’s available.

If the master server loses its own lock, it also shuts itself down. When a new master server is brought online by the cluster management system, it acquires an exclusive lock to announce it’s up and running. The new master then checks with Chubby to find the list of active tablet servers. It queries these servers to figure out which tablets have already been assigned and checks the metadata tablets to identify any unassigned tablets that need attention. For the master server to read these metadata tablets, they need to be loaded by the tablet servers. So, the master first checks if the root tablet is unassigned, verifies the assignments of all servers, and assigns the root tablet if necessary.

Clients cache the location of the tablets and directly query the tablet servers, so data transfer between clients and tablets doesn’t go through the master server. This setup ensures that the master server isn't bogged down with too much load.
![Tablets and Tablet Assignment](/images/bigtable-assignment.png)

## Reading and writing data

Each tablet comprises of three things: A commit log, a memtable and one or more SSTables. 

The commit log is an append-only file that keeps track of every write operation. At the same time, recent writes are also stored in an in-memory data structure called the memtable, which keeps things sorted and relatively inexpensive to query (think of something like Red-Black Trees). Once the memtable hits a certain size, its contents are flushed to a new SSTable. When read requests come in, Bigtable serves them by merging the view from both the memtable and the SSTables. Note that the row key is important to read any data in Bigtable. Hence Bigtable is not meant for use cases where you want to get data based on a certain column value (something like `select * from table where x = 1`). Such a requirement would have to scan the entire table. As you can imagine, that is not very optimal.

The process of flushing the memtable to an SSTable is called a "minor compaction" and it creates new SSTables. From time to time, Bigtable also performs a "major compaction", where it merges multiple SSTables into one. This process combines all the changes made to the same key across multiple SSTables into a single entry, reducing the overall number of SSTables.

![User Tablet](/images/user-tablet.png)

## Optimizations
### Locality Groups
By default, all the column families for a row are stored together in one SST file. But in practice, clients seldom query all column families at once. To handle this efficiently, Bigtable introduces the idea of Locality Groups. A locality group lets you bundle a set of column families together, so rows from same locality groups end up in the same SST files. This setup boosts read performance for queries that only need data from a particular locality group, because it cuts down the amount of data that needs to be read from disk.

### Caching
Bigtable employs two levels of caching within the tablet servers. First, the Scan Cache caches the key value pairs read by the tablet server. This benefits clients that re-read the same keys. Further, a lower level cache called the Block Cache caches the blocks of the SSTs read by the tablet server. This benefits clients who read keys that are adjacent to each other since it's likely that the two keys will be present in the same block.

### Bloom Filter
Sometimes, the keys a client is looking for might not be in the tablet server. In the worst case, the server would have to go through all the SSTables on disk to confirm that the key isn’t there, which can be slow. To make this faster, Bigtable uses Bloom Filters.

A Bloom filter is a clever data structure that helps quickly determine if a key might be in a large dataset. It works by maintaining a buffer of size 'N' and using 'K' hash functions. When a key is added, it's hashed multiple times, and each hash result points to a position in the buffer, which is then set to 1. Later, when checking if a key is in the dataset, the key is hashed again, and the Bloom filter checks those same positions. If all the positions are set to 1, it means the key might be in the dataset. If any position is 0, then the key definitely isn’t there. Bloom filters are probabilistic, so they can sometimes say a key is in the dataset when it isn’t (false positives), but they’ll never miss a key that is actually there (no false negatives).

### Optimizing Commit Logs and Tablet Recovery
We saw that Bigtable writes all mutations into a commit log. If this commit log is maintained per tablet, then it would create a large number of files in the underlying system which will cause lot more disk seeks. To ensure this does not happen, Bigtable maintains one commit logs per tablet server. But this would mean that if a tablet has to be recovered, a tablet server would have to filter out and read only the relevant part of the commit log since it may 
not be handling all the tablets that's been written in the log. Hence Bigtable sorts the commit log before reading it. To optimize this further, the commit logs are divided into blocks and sorting happens parallelly across multiple tablet servers.


When a tablet is reassigned by the master, the current tablet server performs a minor compaction and ensures that the memtable is empty before it releases the Chubby lock. This ensures that the new tablet server does not have to rebuild the memtable by reading the commit log.

## References:
1. [The Big Table Paper](https://static.googleusercontent.com/media/research.google.com/en//archive/bigtable-osdi06.pdf)
2. [Designing Data Intensive Applications by Martin Kleppmann](https://a.co/d/hJtD0fo)
3. [Bloom Filters](https://en.wikipedia.org/wiki/Bloom_filter)





