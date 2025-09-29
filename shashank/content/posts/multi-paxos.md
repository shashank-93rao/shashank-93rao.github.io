---
title: "Multi Paxos"
date: "2025-09-29T22:11:41+05:30"
draft: "false"
---
Multi Paxos is another [Consensus](/posts/consensus) algorithm that's built on top of [Paxos](/posts/paxos).

Basic Paxos talks about consensus on one data point. In vanilla Paxos, the proposer proposes a value and it gets accepted. 
But what if you want to propose a stream of values?



Continue from where we left in Paxos:
1. A proposer's proposal has been accepted.
2. This proposer can propose another value to the acceptors on the same proposal/ballot number. It need not start another prepare phase. Eg: The first proposal `ballot = 1, Log[0] = "Insert X"` was accepted. Now, this node has become the leader. It can keep sending more accept messages on the same ballot number: ```
```
ballot = 1, Log[0] = "Insert Y"
ballot = 1, Log[2] = "Insert Z"
```
3. If this node crashes, another node can begin the prepare phase with a higher ballot number. And as part of the promise response, it receives `ballot = 1, Log[2] = "Insert Z"` .
4. Now, it sends accept message `ballot = 100, Log[3] = "Insert L"`. This get's accepted and it assumes leadership.

[[DynamoDB]]  uses Multi Paxos in a similar manner. A leader per shard is predetermined (probably using 1 round of paxos). The writes are accepted by any node and forwarded to the leader shard node. The leader then performs the write and sends accept message to others to record in their logs in the respective positions.

