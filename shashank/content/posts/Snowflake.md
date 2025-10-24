---
title: Snowflake
date: 2025-10-24T08:39:03+05:30
draft: "false"
tags:
  - database
  - warehouse
---

Snowflake is one of the most popular data warehouses. It operates at petabytes of data scale.
[Read detailed paper here](https://www.cs.cmu.edu/~15721-f24/papers/Snowflake.pdf)

## What's the goal of a data warehouse?
Users of data warehouses often need to analyse vast amounts of data efficiently. A data warehouse typically comprises multiple compute nodes that work in parallel to process this data. The primary goal is to distribute computing resources effectively to analyse data swiftly whilst minimising unnecessary data movement between nodes, ensuring optimal performance and resource utilisation.

![Image](/images/warehouse.png)

## Snowflake Architecture
Snowflake has 3 layers

```
                  +--------------------------------------+
                 |           Cloud Services             |
                 |  (Metadata, Security, WebUI, etc.)  |
                 +----------------+---------------------+
                                  |
              +-------------------+----------------------+
              |                                          |
    +---------v----------+                      +---------v----------+
    |   Virtual          |                      |   Virtual          |
    |   Warehouse 1      |                      |   Warehouse 2      |
    |  (Compute + Cache) |                      |  (Compute + Cache) |
    +---------+----------+                      +---------+----------+
              |                                          |
              +-------------------+----------------------+
                                  |
                        +---------v---------+
                        |    Cloud Storage   |
                        |  (Data and Files)  |
                        +-------------------+

```

1. Data Storage Layer:
	- Data is stored in S3. Snowflake decided to use S3 because it's hard to beat the reliability provided by S3. Any other blob store will also work fine.
	- Since data is stored in S3, the data access pattern is heavily influenced by the APIs provided by S3. 
	- Tables are partitioned into chunks of data files. All files are immutable. Columns are grouped together and highly compressed and written into files in a popular format called PAX. Each file contains a header which contains the offset of each column within the file.
	- Using S3's capability to read files in chunks, snowflake fetches the header of the files and then fetches the column using the offsets.
	- Metadata info such as the files of a table, statistics etc are stored in the metadata store in the cloud services layer.
	  
2. Virtual Warehouses:  
	* A virtual warehouse is a group of compute nodes that the user spins up for query execution.
	* The quality and quantity of nodes is determined by the warehouse size such as X-small, XX-large, etc. The T-shirt sizes are mapped to the actual node sizes and types depending on the compute provider.
	* The compute nodes download data from the storage layer to run queries on the data. Since accessing data storage layer every time can slow down performance, they cache data files locally. The cache operates in an LRU fashion.
	* The cloud services layer is responsible for deciding which query to be executed and which data file to be accessed by a compute node. To ensure efficient usage of the cached local files, the cloud service layer distributes queries and data file usage to nodes using consistent hashing so that queries on a given file land on the same node.
	* Worker nodes do not change the state of the database. They are given a unit of work to perform. Even an update doesn't change the database state since they write new files (which are then used by the control plane in next queries). Hence, a failure in the VW node can be simply retried.
	* The worker nodes are spun up only when there are queries to run. On prolonged idleness, they are shut down.
	* File Stealing: If a VW node is done with scanning the files for a query, it requests its peers for additional files to be scanned. If a peer is executing queries slowly, then on receiving such a request, it transfers ownership of some files to the requesting node. The requester downloads the file from the peer rather than from S3.
	  
3. Cloud Services Layer: 
	* Think of this as the control plane. It is responsible for access control, metadata storage, web UI, parsing, catalog management etc. 
	* Snowflake uses snapshot isolation along with MVCC. When the query begins, it looks at the latest files that have been written by worker nodes.
	* Pruning: Snowflake maintains statistics around each file so that it can reduce the number of files to be scanned based on the query conditions.

### Availability
* Snowflake deploys its control plane services in multiple AZs behind load balancers. If a node fails, it can be simply retried in a different zone.
* The metadata store is also distributed across multiple AZs. Snowflake [uses FoundationDB](https://www.snowflake.com/en/blog/how-foundationdb-powers-snowflake-metadata-forward/) which is a distributed, ACID compliant KV store. 
* VWs are not spread across AZs. This is simply because spreading nodes between multiple AZs will affect performance since the network latency between different AZs is obviously going to be higher. In case of a complete AZ failure, a new warehouse will have to be spun up.
* Storage resilience is taken care by S3 by distributing data storage in multiple AZs.
* Any code update is done in a backward compatible manner. New versions are deployed alongside old version of services. Once the users are switched to newer versions, all new queries will go through new services. Once all the customers are switched to new versions and there are no takers for old services, they are shut down.

### Time Travel
* Since all data files are immutable, old versions of data can be queried up to a certain period beyond which they are deleted. This period can be configured. 
* At any point in time, users can restore old data (say if a table was deleted by mistake).
* This immutability also helps with a feature called cloning. Snowflake provides a feature called Clone, which creates a new table out of an existing table. The cloned table and the source table point to the same data files. Hence, cloning becomes very quick. On modifications, new files are created and the metadata is updated.

