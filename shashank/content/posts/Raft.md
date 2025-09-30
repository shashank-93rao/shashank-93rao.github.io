---
title: Raft
date: 2025-09-30T21:48:51+05:30
draft: "false"
---

Raft is one of the most popular [Consensus]({{< ref "Consensus" >}}) algorithm that's present today. Can read more about it [here](https://raft.github.io/raft.pdf). 

Built as an alternative to the [Paxos]({{< ref "Paxos" >}}) group of algorithms, it is built mainly to simplify the understanding of consensus algorithm.

Raft's usage is to replicate the sequence of state changes in distributed machines. These states are stored in a log and then applied by the state machines to derive the final state. If the order of the states is correct, then all machines will have the correct state.

Understanding Raft can be split across multiple concepts
### Leader Election
At any point of time, a node is either a leader, a follower, or a candidate. A node frequently receives a heartbeat from the leader. If the heartbeat isn't received within the *election timeout*, then it initiates the election.

State: {currentTerm, currentTermVotedFor, log[]}

When a node initiates election, it becomes a candidate. A candidate node increments its term and initiates voting request to all the nodes.

RequestVote(term, lastLogEntryIndex, lastLogEntryTerm, requesterId)

When the receiver receives the voting request:
```
If requestTerm < currentTerm:
	return reject; // Election already done and dusted

if requestTerm > currentTerm:
	currentTerm = requestTerm // it's a new election
	currentTermVotedFor = null // haven't voted yet

if requestTerm >= currentTerm && (currentTermVotedFor <mark> null || currentTermVotedFor </mark> requesterId):
	// This is a term which I haven't voted in
	
	if myLastLogEntryIndex <= requestLastLogEntryIndex && myLastLogEntryTerm <= requestLastLogEntryTerm:
		// The candidate is atleast as much upto date as me
		currentTermVotedFor = requesterId
		return accept;

return reject;	
```

If the candidate received enough votes, it assumes leadership and asserts it by sending heartbeat message. Heartbeat is a simple log replication message with 0 entries. This is explained below.

## Log Replication
The leader sends the following message:
Replicate (term, prevEntryIndex, prevEntryTerm, entries[], commitId)

```
If term < currentTerm:
	// Accept requests only from the leader who won the current term
	return reject;

if log[prevEntryIndex].term != prevEntryTerm:
	// The log of the leader is out of sync with my log
	return reject;

if there exists conflict between any entry and existing log entry (terms different):
	// overwrite the entries from that position to the last position

if leaderCommitIndex > myCommitIndex:
	// Leader might be ahead of me, so commit only till my last entry
	myCommitIndex = min(leaderCommitIndex, lastEntryIndex)
```

##### Leader Step Down
In the log replication case, a leader can get a rejection. The rejection always has the follower term associated with it. In case the rejection happened because the follower has a higher term, it means someone else has become the leader. The current leader steps down and waits for vote or heartbeat from the new leader.
##### Leader retry on divergence
If the replication message is met with rejection not because of term, then it means that the follower accepts us as the leader, but there's a divergence on the last entry of the follower and the leader. The leader performs a retry by reducing the commit log index for that particular follower and checks if it is acceptable. This continues till the leader and follower find a common ground. i.e. `followerLog[prevIndex].term == leaderLog[prevIndex].term`. Once this is established, the follower replaces the conflicting logs with the entries sent by leader.
##### Commit vs Replicated
There's a difference between commit and replicated.
The leader sends replication message to all followers. Here, the intention is to replicate. Once the majority of followers respond positively, that's when we know that it's committed. The leader has to now increment the commitIndex and pass on the replication message with the new commitIndex to all the followers.
Usually, this second message is piggybacked on some other replication message, or it's part of heartbeat.
