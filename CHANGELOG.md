# Changelog

## [0.6.0](https://github.com/firetower-cloud/firetower/compare/firetower-v0.5.1...firetower-v0.6.0) (2026-08-22)


### Features

* Claude Code sessions run in auto ([c7e0c75](https://github.com/firetower-cloud/firetower/commit/c7e0c75ba18e63e069241df22f098be7bf4a6469))
* Claude Code starts with edits already approved ([7e98b98](https://github.com/firetower-cloud/firetower/commit/7e98b9812616de9ab8b9d7d3db6621c4c6e4a210))


### Bug Fixes

* the worker's --help describes the worker ([cc6fcea](https://github.com/firetower-cloud/firetower/commit/cc6fceaa20a993eb174098ada347c0f5b328d124))

## [0.5.1](https://github.com/firetower-cloud/firetower/compare/firetower-v0.5.0...firetower-v0.5.1) (2026-08-22)


### Bug Fixes

* `cargo run -p ft-cli` knows which binary it means ([ed07e48](https://github.com/firetower-cloud/firetower/commit/ed07e485ac95bb96a3b95e049c17f4ea6ba66f95))
* the worker answers the callbacks it makes into itself ([cdb67ee](https://github.com/firetower-cloud/firetower/commit/cdb67ee4d5e295de0e3df4e5cfac566952a6ced7))

## [0.5.0](https://github.com/firetower-cloud/firetower/compare/firetower-v0.4.0...firetower-v0.5.0) (2026-08-22)


### Features

* Firetower dials out with a key of its own ([6b7a9aa](https://github.com/firetower-cloud/firetower/commit/6b7a9aa992e677be759901ef572809f7e56df97b))
* say what a machine still needs, where you are looking ([4b3c86d](https://github.com/firetower-cloud/firetower/commit/4b3c86d963c580e354672789fb479739e7491863))
* the worker gets a name no person types ([1e8f755](https://github.com/firetower-cloud/firetower/commit/1e8f7558865f0ddff5c50d0491fec9e1087aa365))


### Bug Fixes

* stop the dev stack sharing a namespace with a deployment ([0262117](https://github.com/firetower-cloud/firetower/commit/0262117957c65e0a9aa097a6406fcfbe62948a35))
* try a machine before adding it, and remember its host key ([3b1f614](https://github.com/firetower-cloud/firetower/commit/3b1f614649d99b893c87a0cd2952d0141222b409))

## [0.4.0](https://github.com/firetower-cloud/firetower/compare/firetower-v0.3.0...firetower-v0.4.0) (2026-08-19)


### Features

* a shell and the files of a session ([00109df](https://github.com/firetower-cloud/firetower/commit/00109df7e62764405eff18f03c81f9d1772eb0a2))
* force remove a session whose host is gone ([dc433e8](https://github.com/firetower-cloud/firetower/commit/dc433e8dd900154502c26d7c76d40db6b17bd856))
* per-repository environment variables ([3426a31](https://github.com/firetower-cloud/firetower/commit/3426a3143b9de23bcafb7666df78c8948e4345b0))
* sessions get a name ([84ad8ab](https://github.com/firetower-cloud/firetower/commit/84ad8ab803966c72500d49e4da9e06bd2a839ddb))
* the chart labels agents by name ([b7846c5](https://github.com/firetower-cloud/firetower/commit/b7846c5a116e5e67e46d898cb6e0792ffae45084))
* the terminal is focused when you open a session ([8b61a33](https://github.com/firetower-cloud/firetower/commit/8b61a33381d14db749875196ac13a60d042e2a6c))


### Bug Fixes

* the card shows the question the agent is asking ([6e9d5dc](https://github.com/firetower-cloud/firetower/commit/6e9d5dc150b368694c948f8eb0402461fa3ae0e2))

## [0.3.0](https://github.com/firetower-cloud/firetower/compare/firetower-v0.2.0...firetower-v0.3.0) (2026-08-19)


### Features

* a worker can dial in, and an image to run the control plane from ([d7c244f](https://github.com/firetower-cloud/firetower/commit/d7c244f4ee68ae0691a320a120dd79cad406745d))
* accounts, and a wizard that finishes setting up ([a066e13](https://github.com/firetower-cloud/firetower/commit/a066e131c26078c8755900054130441c1aeb1db9))
* an unreachable machine stops being fatal ([e8ad612](https://github.com/firetower-cloud/firetower/commit/e8ad6121c5d07cdb0b6d1c59e5e76bedff2e20cd))
* authentication, a bind address, and health checks ([8db94db](https://github.com/firetower-cloud/firetower/commit/8db94dbc32c0a6334f2881b519d8755f5f371ab0))
* one command to run Firetower on a machine you own ([7270188](https://github.com/firetower-cloud/firetower/commit/7270188178b73faa2acb552a7a28a9add6bdbb1a))
* servers are named, not addressed ([ae03386](https://github.com/firetower-cloud/firetower/commit/ae03386408d2cb68e927cd065b150950c4dfef8d))
* the agent says when it stopped ([67a3e2f](https://github.com/firetower-cloud/firetower/commit/67a3e2f4955f39fbd2adb85f3a6e7b5111fb88b8))
* the interface, inside the binary ([288a1c4](https://github.com/firetower-cloud/firetower/commit/288a1c4cca6451f0e2f82ceb4a0e89224d26bf9d))


### Bug Fixes

* a password that must change sends you to the wizard ([2ce8ffd](https://github.com/firetower-cloud/firetower/commit/2ce8ffd5a6b3ce28f3610bbfd6c80433253d081f))
* a session goes back to working, and says what it actually wants ([4a5302e](https://github.com/firetower-cloud/firetower/commit/4a5302ea51a3cbb3407c747a8bb0ad72360d37fa))
* a short initial password no longer stops Firetower starting ([f916a75](https://github.com/firetower-cloud/firetower/commit/f916a7584ebc54463f63ebb86b4adc52557ff663))
* five characters, not twelve ([9670988](https://github.com/firetower-cloud/firetower/commit/9670988df7c67b495be3166f6c02aa3d5dd50b88))
* one unreadable host no longer stops the control plane ([beab775](https://github.com/firetower-cloud/firetower/commit/beab775bf1dc657a3bbaceb4e382ada879a24116))
* opening a session works on the dev server again ([81e0a19](https://github.com/firetower-cloud/firetower/commit/81e0a1938fdefff4ad99f1e39a381b40a785a4d2))
* setting up no longer throws you out of itself ([6de1af8](https://github.com/firetower-cloud/firetower/commit/6de1af81ade4622dd48b2fac5b5c26ad7b7dcdc0))
* the crate creates the folder it embeds ([a4769bc](https://github.com/firetower-cloud/firetower/commit/a4769bc9d2a61b132fc5ee602a5e39d48f756568))
* the interface updates by itself again ([f786aa4](https://github.com/firetower-cloud/firetower/commit/f786aa41268a3b0a0f757ca01dcd631732e0fab9))
* the onboarding tour does what it describes ([b5fd276](https://github.com/firetower-cloud/firetower/commit/b5fd2767059a385553d845e0f3b8147092e399da))
* the tests tidy up after themselves ([c49fa1f](https://github.com/firetower-cloud/firetower/commit/c49fa1f5d7dae3dffec4f1617a25b0af97c39f15))
* the wizard ends with one button, to a real page ([5edad11](https://github.com/firetower-cloud/firetower/commit/5edad11cc156b282f69c7bb5ccf59f48438e99b4))
* **worker:** a long history no longer wedges the worker ([1e505b3](https://github.com/firetower-cloud/firetower/commit/1e505b39d9d3038aeefe6778b0dec7bbceeed30d))


### Reverts

* the worker does not dial in ([e32f701](https://github.com/firetower-cloud/firetower/commit/e32f701a286af58bf2cb3b743402b746285f457f))

## [0.2.0](https://github.com/firetower-cloud/firetower/compare/firetower-v0.1.0...firetower-v0.2.0) (2026-08-16)


### Features

* encrypted secret store, Postgres, and somewhere to run agents ([78a9726](https://github.com/firetower-cloud/firetower/commit/78a972614e5d7a6d7731b72a1ec0f0029587d966))
* reach servers over ssh, and say why when they don't answer ([8a976f4](https://github.com/firetower-cloud/firetower/commit/8a976f476a935e296d986f3249e00efbec8e4a46))
* wip — run and control agent sessions ([1ea0c10](https://github.com/firetower-cloud/firetower/commit/1ea0c1093a56338b441a254f2083b17c48960569))


### Bug Fixes

* **ci:** release from a version marker, not a cargo manifest ([4bbbd23](https://github.com/firetower-cloud/firetower/commit/4bbbd2365351d429917eb4bb8354270986cdc35d))
* keep a session visible while it is being built ([106f3c4](https://github.com/firetower-cloud/firetower/commit/106f3c42c48ea659a4161ffa109546a3a55c9276))
