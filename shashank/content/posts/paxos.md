---
title: Paxos
date: 2025-09-29T21:52:55+05:30
draft: "false"
---

Paxos is a simple [Consensus](/posts/consensus) algorithm. 
It was introduced by Leslie Lamport. Can read more [here](https://lamport.azurewebsites.net/pubs/paxos-simple.pdf)

Paxos guarantees that there is consensus among multiple processes.

Setup: X nodes/processes
Works in phases:
1. The proposer chooses a proposal number *p* with the given value *v*. It sends the message *prepare(p,v)* to a set of nodes >= x/2 + 1 (majority)
2. At the acceptor end, there are two cases:
	1. Received prepare(p,v). Already accepted a proposal (x, y) where *x>p*. Ignore the message (or send a negative reply).
	2. If already accepted proposal (x, y) where *x<p*. Promise the proposer that I won't accept any proposal with proposal number < p. Send the values *(x,y)* as part of promise to the proposer. (if nothing was previously promised, then send p,v)
3. At proposer end:
	1. If the majority of acceptors did not respond, then your proposal was rejected. Repeat with higher proposal number.
	2. If received promises from the majority of acceptors, then we need to set value to our proposal.  Value for proposal = value of the highest proposal number received in the promise responses. 
4. Accept phase: Now send an accept message to all the acceptors with your proposal number and the value you decided in the previous step. If you receive acks from majority, then consensus is reached. Else, repeat.

Note: Ballot number has to be unique across nodes. Else it breaks safety in Paxos. Maybe the nodes can memorize who sent what ballot as part of their promise and reject another node sending same ballot number.

