# Learning log

## 2026-10-15 — Agent instruction setup

Using one canonical file gives Claude Code and the Antigravity agent a single source of truth. If each agent had its own copy of the project instructions, those copies could gradually become different, causing the agents to follow different rules. With one shared file, I only need to update the instructions once. Both agents still need to know where that file is and when to read it.

Automatic loading means the instructions are given to the agent before it starts working. On-demand loading means the agent reads the file when it needs that information. On-demand loading only works reliably when the agent knows where to find the file and when to use it.

The Valkey mistake showed me what can happen when instructions leave out important details. The skill said to “record the marker” but did not say where. Because Valkey appeared throughout the rules, the agent assumed it was the right place. The agent loading test exposed that mistake. I updated the instructions to say the marker belongs in the API server’s own memory, not Valkey. Then I ran the test again, and it passed.
