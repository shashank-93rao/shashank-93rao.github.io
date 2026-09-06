---
title: Consensus
pubDatetime: 2025-09-29T21:34:06+05:30
draft: false
tags:
  - consensus
  - distributed-systems
series: consensus-algorithms
order: 1
description: What consensus algorithms are, the problem they solve, and how consensus relates to log replication and leader election in distributed systems.
---

Requirements of consensus:
* Single proposed value is chosen
* Value chosen is proposed by the processes that are part of the system
##### **What do consensus algorithms do? What is the problem they solve?**
Consensus means agreement. In a distributed system, multiple nodes agreeing on a state is facilitated by consensus algorithms. But it's not just one single value! Distributed systems keep getting a sequence of state change events that are constantly applied. All nodes will have to agree on the sequence of state changes as well. If in a three node system of nodes A, B, C, node A receives a sequence of state changes X, Y, Z, then it needs to propagate this set of state changes to the remaining two nodes in the very same order. This is basically Log Replication!
Consensus and replication are closely related! Reliable, consistent and correct/safe replication requires consensus!

Another use case is Leader Election
