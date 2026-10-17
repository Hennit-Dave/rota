# Learning log

## 2026-10-15 — Agent instruction setup

Using one canonical file gives Claude Code and the Antigravity agent a single source of truth. If each agent had its own copy of the project instructions, those copies could gradually become different, causing the agents to follow different rules. With one shared file, I only need to update the instructions once. Both agents still need to know where that file is and when to read it.

Automatic loading means the instructions are given to the agent before it starts working. On-demand loading means the agent reads the file when it needs that information. On-demand loading only works reliably when the agent knows where to find the file and when to use it.

The Valkey mistake showed me what can happen when instructions leave out important details. The skill said to “record the marker” but did not say where. Because Valkey appeared throughout the rules, the agent assumed it was the right place. The agent loading test exposed that mistake. I updated the instructions to say the marker belongs in the API server’s own memory, not Valkey. Then I ran the test again, and it passed.

## 2026-10-16 — ADRs (self-study) and the server scaffold
ADR means Architecture Decision Record. It is a document used to keep track of an important technical decision made in a project, why that decision was made, the other options that were considered, and the trade-offs involved.
For the server toolchain, I chose TypeScript 6.0.3 instead of TypeScript 7 because `typescript-eslint`, which will be used in a later slice, currently supports TypeScript versions below 6.1.0. Choosing TypeScript 7 now could therefore create compatibility problems later.
Writing this as an ADR means i do not just record what was chosen. I also record why I rejected the other option, so someone reading the project later does not need to repeat the same research.
Another important part of an ADR is the revisit condition. A technical decision does not always have to stay permanent. In this case, I can reconsider TypeScript 7 when `typescript-eslint` supports the 7.x version and Prisma officially confirms support for it.
What I understand from this is that an ADR is not just documentation of a choice. It is a record of the reasoning behind the choice and the condition that could make me change it later.