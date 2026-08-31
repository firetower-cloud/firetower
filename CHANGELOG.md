# Changelog

## [0.19.0](https://github.com/firetower-cloud/firetower/compare/firetower-v0.18.0...firetower-v0.19.0) (2026-08-31)


### Features

* file search and better file tree ([f059c14](https://github.com/firetower-cloud/firetower/commit/f059c145b299faa832d172867259d312d3cc6479))
* preview a session's ports on your own machine ([05bd861](https://github.com/firetower-cloud/firetower/commit/05bd8619ab9aa390ce5f2a7b9998cf57afb8a0eb))

## [0.18.0](https://github.com/firetower-cloud/firetower/compare/firetower-v0.17.0...firetower-v0.18.0) (2026-08-30)


### Features

* finish a workspace when its pull request does ([5a9cef4](https://github.com/firetower-cloud/firetower/commit/5a9cef4d3d8d3d2bfa312e482aa2a8ad9f066efa))


### Bug Fixes

* notice a merged pull request in seconds rather than a minute ([747a6d8](https://github.com/firetower-cloud/firetower/commit/747a6d87282fd176bc6fb3658a23f29f42c868c0))

## [0.17.0](https://github.com/firetower-cloud/firetower/compare/firetower-v0.16.0...firetower-v0.17.0) (2026-08-30)


### Features

* **worker:** hand the conversation to a restarted agent ([b9fa5b6](https://github.com/firetower-cloud/firetower/commit/b9fa5b61e75469457c8674b002e4eaa67b151fa3))


### Bug Fixes

* **worker:** hand the conversation over instead of leaving it about ([aa7a78e](https://github.com/firetower-cloud/firetower/commit/aa7a78e7faacca901a2c925fa7abcb2f31abbcda))
* **worker:** start a conversation when one cannot be resumed ([7b6620e](https://github.com/firetower-cloud/firetower/commit/7b6620e1b46eab85e6d33576a73be4d3335c9a6d))

## [0.16.0](https://github.com/firetower-cloud/firetower/compare/firetower-v0.15.0...firetower-v0.16.0) (2026-08-30)


### Features

* **core:** bring a session's agent back ([fd8d607](https://github.com/firetower-cloud/firetower/commit/fd8d60758c7c6244d77355c241f92ec0c204d742))


### Bug Fixes

* **core:** say when a question has been answered ([b349627](https://github.com/firetower-cloud/firetower/commit/b3496275b703e103cc36324b741e9d3422ed0c1a))

## [0.15.0](https://github.com/firetower-cloud/firetower/compare/firetower-v0.14.0...firetower-v0.15.0) (2026-08-30)


### Features

* **web:** drawings render as drawings ([728bd84](https://github.com/firetower-cloud/firetower/commit/728bd84453791e18578337fc14345af7b02f7cd6))


### Bug Fixes

* **server:** push a branch with the owner's token ([592308a](https://github.com/firetower-cloud/firetower/commit/592308a8b2ca8da03cf2504c71cd8850d032c0e7))
* **server:** record session status against the workspace ([0794861](https://github.com/firetower-cloud/firetower/commit/07948610c2c3841e900a19f2d2c7cf6f8d4b4ad5))

## [0.14.0](https://github.com/firetower-cloud/firetower/compare/firetower-v0.13.0...firetower-v0.14.0) (2026-08-30)


### Features

* closing an agent's tab ends the agent ([c298374](https://github.com/firetower-cloud/firetower/commit/c2983740e4293bd72489b9e3936f0264ee68e7fb))
* create a workspace, and see what it is called ([c980019](https://github.com/firetower-cloud/firetower/commit/c98001994776e49b5d8f11ff10daceec4d610627))
* home is a page in the rail again, with an overview of everything ([bad6bf1](https://github.com/firetower-cloud/firetower/commit/bad6bf1d0c17e064241f1db2331280ff6fe2f8bb))
* home is a place again, and the workspace screen is only work ([17fafd2](https://github.com/firetower-cloud/firetower/commit/17fafd2fc6a6e40de9e22eb5d1eb4c0e3d2d6342))
* install an agent onto a host from the interface ([7a13941](https://github.com/firetower-cloud/firetower/commit/7a139416a2c825e2dbc04ac054534b528e7192ab))
* one rail everywhere, and setup behind Configuration ([f4931d0](https://github.com/firetower-cloud/firetower/commit/f4931d083013c0fb6f768fe815486eeb3a4b5136))
* pull tasks from GitHub and start a worktree from one ([8e28f30](https://github.com/firetower-cloud/firetower/commit/8e28f30b00e153cb52fa8ab15ef5a9b3b35c94f2))
* redesign the tab system and theme ([ba5d4b3](https://github.com/firetower-cloud/firetower/commit/ba5d4b3f5b1d568a9b4863d645baf436e5d44ba7))
* **server:** one socket for everything that changes on its own ([b5358d7](https://github.com/firetower-cloud/firetower/commit/b5358d7f56bc01531ff0a13d7eaaf7d0f90643a2))
* several agents in one workspace ([7a7217a](https://github.com/firetower-cloud/firetower/commit/7a7217a62d883ec00aafc213cbdc3a68d58690ff))
* the interface on the new system, and a dashboard you can act on ([514dd0c](https://github.com/firetower-cloud/firetower/commit/514dd0c5743966728dc91a03fb91b1bf1353b97c))
* **web:** a workbench, instead of one session per page ([0ec96fb](https://github.com/firetower-cloud/firetower/commit/0ec96fb6515d292dcac0d9e01befd4820dfd4a8d))
* **web:** connect a repository from the new-worktree dialog ([da74565](https://github.com/firetower-cloud/firetower/commit/da745653332800ac73570a75c56522c051602bb9))
* **web:** name the workspace, not the task ([73de7b1](https://github.com/firetower-cloud/firetower/commit/73de7b1119722cc1495a179ce4876b9e070ce8b5))
* **web:** read a task before starting it, and never send it for you ([6d8fea2](https://github.com/firetower-cloud/firetower/commit/6d8fea21340e828fb02c12e09529f95a8cd28c93))
* **web:** show the work, not a summary of it ([68583d0](https://github.com/firetower-cloud/firetower/commit/68583d0f7ace7978fb1d398651fd60cf0bd30cc0))
* **web:** tabs belong to a session, and the header between them goes ([a6851e3](https://github.com/firetower-cloud/firetower/commit/a6851e3b824180b1e858753d71dab1b19e92f58f))
* **web:** the page follows one socket instead of one stream per tab ([1be40d9](https://github.com/firetower-cloud/firetower/commit/1be40d9967f93adfdbece8fd083c7bca4cb09f6e))
* **web:** the rail groups runs under the workspace they are in ([d6a6f57](https://github.com/firetower-cloud/firetower/commit/d6a6f579e75e02a2f14c4f654e5a628e077d25eb))
* **web:** the rail's + cuts a worktree ([4efe344](https://github.com/firetower-cloud/firetower/commit/4efe34430153b3482faa0421a048fc4eee8b57f6))
* **web:** the right panel switches views, and shipping is one of them ([063f926](https://github.com/firetower-cloud/firetower/commit/063f9269c8dd8e98c841dc4ad82386a7ddb0c058))
* **web:** tokens and primitives for one design system ([647270f](https://github.com/firetower-cloud/firetower/commit/647270f06139f6409c8c803657f1872cdb073c53))


### Bug Fixes

* a conversation that stopped had nothing to restart it ([ffc5d96](https://github.com/firetower-cloud/firetower/commit/ffc5d96b5bfe37e99d8b066c4287a69b982e3c1f))
* an agent's transcript is its own, and so is its tab ([d026ee0](https://github.com/firetower-cloud/firetower/commit/d026ee0de8f0be87201d68649cb8cb32b40d7469))
* say when the agent is ready, and stop calling it Working ([143aae8](https://github.com/firetower-cloud/firetower/commit/143aae895e574403fafd443c712cfb2d869ba9b2))
* **server:** Codex opened every session by asking it nothing ([62111a6](https://github.com/firetower-cloud/firetower/commit/62111a6e3397b33d2b477dc410f3d89e6c0d727d))
* **web:** a discarded socket was clearing the reference to its replacement ([56f6674](https://github.com/firetower-cloud/firetower/commit/56f66743239ab5732bfe481d56e875afe83861a5))
* **web:** four pixels inside the terminal, not three ([0f68128](https://github.com/firetower-cloud/firetower/commit/0f681283798a4b834795071e4ac4c4a20b046897))
* **web:** give the composer its edges back, and stop the restore eating a link ([db85dfa](https://github.com/firetower-cloud/firetower/commit/db85dfabbaa34a9eda3b9ec818f82d6c39102910))
* **web:** the agent list vanished from the new-tab menu ([b522a49](https://github.com/firetower-cloud/firetower/commit/b522a498c63d60f5e69629304da08ccef77a1e1f))
* **web:** the new-tab menu said "no agents" while it was still asking ([0037bc4](https://github.com/firetower-cloud/firetower/commit/0037bc44a0bded17ae66e38c94a08e164ba415c5))
* **web:** the terminal is the pane ([b51f833](https://github.com/firetower-cloud/firetower/commit/b51f83390f5c50834020a6962ce7df07ad89e6de))
* **web:** three pixels inside the terminal ([31d2aab](https://github.com/firetower-cloud/firetower/commit/31d2aabd3208154894bd24bf56e8ecc0e80c64ea))
* **worker:** a new agent waited on the log its neighbour left behind ([dc0b409](https://github.com/firetower-cloud/firetower/commit/dc0b409812689c71b69a6d53630346c0f993bea9))
* **worker:** one diff from the merge base, so a file is listed once ([538fedd](https://github.com/firetower-cloud/firetower/commit/538feddd9c82c22a93d97103188f41fb0989c211))


### Performance Improvements

* **web:** stop polling for what the socket already pushes ([0cb8b19](https://github.com/firetower-cloud/firetower/commit/0cb8b1905f495afcf03c112272a9df1195982b28))

## [0.13.0](https://github.com/firetower-cloud/firetower/compare/firetower-v0.12.0...firetower-v0.13.0) (2026-08-27)


### Features

* **codex:** confine the agent rather than interrogate it ([cd115bf](https://github.com/firetower-cloud/firetower/commit/cd115bfa5e5df5631eaed22f3587a0fa1b463f5d))
* **codex:** route what it stops for to the card that exists ([8a0e7ef](https://github.com/firetower-cloud/firetower/commit/8a0e7efe3706b4c2c0d87e2897db9b73337bff27))
* **codex:** stop a turn, and survive a restart ([3b25884](https://github.com/firetower-cloud/firetower/commit/3b25884f8858e521e81874734cc7866d2c4437a2))
* **codex:** what a turn cost, and how much of the plan is left ([28bc778](https://github.com/firetower-cloud/firetower/commit/28bc778f2b1d9d23f1fd73ce852069dfb8dfe203))
* connect Codex from the browser ([d5fed03](https://github.com/firetower-cloud/firetower/commit/d5fed030bfa0fbf864eb1a23b82c1bd932de75b3))
* drive Codex ([83633f7](https://github.com/firetower-cloud/firetower/commit/83633f71550a20d223a7773c5f05c154c9757016))
* hand Codex its credential per session ([48ff8c4](https://github.com/firetower-cloud/firetower/commit/48ff8c41e69a32b4634f1c82b8044b7dc44ea834))
* the session controls belong to the agent, not the browser ([5469f6a](https://github.com/firetower-cloud/firetower/commit/5469f6a97b8d9b765f1d68f59f8c9094cf38a498))
* **worker:** sign Codex in with a device code ([dec2666](https://github.com/firetower-cloud/firetower/commit/dec2666fa8894850f51da1eaabef99fbeeea70fb))


### Bug Fixes

* **codex:** open the conversation one message at a time ([37fce05](https://github.com/firetower-cloud/firetower/commit/37fce059a3eed2d77c6d047e5fef6022930798de))
* **codex:** put the words in the bubble ([2b93dcc](https://github.com/firetower-cloud/firetower/commit/2b93dcc444f45cab90506a6acd6420000e371850))
* **codex:** read the thread id from where it actually is ([4a5cba7](https://github.com/firetower-cloud/firetower/commit/4a5cba7db655a9bdc8127cc2dce4285d31794887))
* **codex:** show what the session is actually running ([ad980a4](https://github.com/firetower-cloud/firetower/commit/ad980a493620823baddf6a7256e53f091b228f73))
* **server:** a clean lint ([be1a657](https://github.com/firetower-cloud/firetower/commit/be1a6573c1b760c6ecb1f41dcae52667ecec4bf3))
* stop forwarding every line twice ([65b7ef2](https://github.com/firetower-cloud/firetower/commit/65b7ef2a1be10c7d90114730f0ce9bf4d1ddc66d))
* **web:** let Codex be connected before it can be driven ([1cded9f](https://github.com/firetower-cloud/firetower/commit/1cded9fd8839c303bf1810fb39c1678349b69a20))
* **worker:** a dead watcher was holding the slot ([d597774](https://github.com/firetower-cloud/firetower/commit/d597774b0a7bf94ba925329ab84b1dc420a97d65))
* **worker:** sweep sign-ins nobody finished ([18ea846](https://github.com/firetower-cloud/firetower/commit/18ea8464d85077af709cb99139ba11fe7c6c483b))

## [0.12.0](https://github.com/firetower-cloud/firetower/compare/firetower-v0.11.0...firetower-v0.12.0) (2026-08-25)


### ⚠ BREAKING CHANGES

* the worker image no longer contains Claude Code. An existing worker keeps working — the binary is still in its old image until it is recreated — but a worker installed or upgraded from this version has no agent until one is added. `firetower worker install` now asks which to install, and `firetower worker agents add claude-code` does it afterwards.

### Features

* agents are installed onto the volume, not baked into the image ([2e26a5d](https://github.com/firetower-cloud/firetower/commit/2e26a5de98f714a8bdb923383267c41192e930b9))

## [0.11.0](https://github.com/firetower-cloud/firetower/compare/firetower-v0.10.0...firetower-v0.11.0) (2026-08-25)


### ⚠ BREAKING CHANGES

* the schema is replaced rather than migrated. There is no upgrade path and none is wanted — nothing has been installed from the old migrations that anybody has to keep. Existing installs start over: `just reset`.

### Features

* one Firetower, several people ([5af538f](https://github.com/firetower-cloud/firetower/commit/5af538f2b7cee67b27c97975dc0dc200009b9ef1))
* **web:** fold a run of tool calls into one row ([7f4ae1f](https://github.com/firetower-cloud/firetower/commit/7f4ae1f83654b18650dd68264de9e548dffe3fd8))
* **web:** say who your commits are authored as, and change it ([910af25](https://github.com/firetower-cloud/firetower/commit/910af2549db2f7dae334ff3e941ed74d56f2bc2f))


### Bug Fixes

* stopping a session no longer leaves it unusable ([5aaf18e](https://github.com/firetower-cloud/firetower/commit/5aaf18e13fc54ba2a9b3e2cb1579e0b92b778d47))
* **web:** a question card taller than the window trapped the session ([cfcad35](https://github.com/firetower-cloud/firetower/commit/cfcad357a18080e2191f19f346e103d432900301))
* **web:** a stray 0 under the composer ([091f7a2](https://github.com/firetower-cloud/firetower/commit/091f7a2d60a8df53f9a967d53ea8eadb5695886c))
* **web:** an invisible reasoning block stopped anything folding ([77b3421](https://github.com/firetower-cloud/firetower/commit/77b3421c45da9fa3fc2c5475b7237803516f433c))
* **web:** the rail told you what was true when the page loaded ([ceeb680](https://github.com/firetower-cloud/firetower/commit/ceeb680288ff60040e4c2f00613cb7ae8517282e))
* **web:** writing a note no longer drags the transcript to the bottom ([041a13f](https://github.com/firetower-cloud/firetower/commit/041a13fcb7a9adbc4930542591ae39bb3d4e3e36))

## [0.10.0](https://github.com/firetower-cloud/firetower/compare/firetower-v0.9.1...firetower-v0.10.0) (2026-08-24)


### Features

* **web:** get a session's branch as a worktree on your own machine ([69df760](https://github.com/firetower-cloud/firetower/commit/69df760709d51c4bbb8d0b1dee72d02d68b395e4))


### Bug Fixes

* a commit that committed nothing said it had ([0ee41f9](https://github.com/firetower-cloud/firetower/commit/0ee41f95d54df4adc7e63b81061ee998556b24f7))
* say what the git host actually refused ([765a7b0](https://github.com/firetower-cloud/firetower/commit/765a7b0aea2709a2ccc521a753acbadcd0f7969f))

## [0.9.1](https://github.com/firetower-cloud/firetower/compare/firetower-v0.9.0...firetower-v0.9.1) (2026-08-24)


### Bug Fixes

* sessions that collide, and controls that say what they do ([e92a13f](https://github.com/firetower-cloud/firetower/commit/e92a13f49ed710161bf6cb49e5caa0e87858252d))

## [0.9.0](https://github.com/firetower-cloud/firetower/compare/firetower-v0.8.0...firetower-v0.9.0) (2026-08-24)


### Features

* let the operator choose the ports Caddy publishes ([c079276](https://github.com/firetower-cloud/firetower/commit/c07927633221c28dcc8261624e9c97ceb8e4e4d8))
* stop offering the shell as an agent ([c68e798](https://github.com/firetower-cloud/firetower/commit/c68e798bd0414058ab892aa97472a60d15921599))
* **web:** a link to the documentation on the rail ([90a85e5](https://github.com/firetower-cloud/firetower/commit/90a85e503b63f8972e14a40d6562694ba9b813d5))
* **web:** say which agents Firetower can actually run ([ab1fea2](https://github.com/firetower-cloud/firetower/commit/ab1fea28f809e916b74fa7c56c231afd26a0c0f8))


### Bug Fixes

* **web:** the launch shortcut goes on the launch button ([44085bc](https://github.com/firetower-cloud/firetower/commit/44085bcda04403af370055e12409f2b1b3581573))

## [0.8.0](https://github.com/firetower-cloud/firetower/compare/firetower-v0.7.0...firetower-v0.8.0) (2026-08-23)


### Features

* a session can hold more than one repository ([03f105a](https://github.com/firetower-cloud/firetower/commit/03f105a4a52b608d854401b6e271e7ad0e9fc117))


### Bug Fixes

* add the checkout's pull request in its own migration ([c2308f3](https://github.com/firetower-cloud/firetower/commit/c2308f34edc79bd517677811eba510c03132b2ee))
* **web:** a base branch per repository, and Escape lets you back in ([0946199](https://github.com/firetower-cloud/firetower/commit/0946199a601133c02bb78599cf69f674c6212432))
* **web:** the repository picker opens outside the composer ([46da6f2](https://github.com/firetower-cloud/firetower/commit/46da6f2a5de988d196f4aa57b37f336fd656ce05))

## [0.7.0](https://github.com/firetower-cloud/firetower/compare/firetower-v0.6.0...firetower-v0.7.0) (2026-08-23)


### Features

* a session screen you can read, and a meter that means something ([1b3db21](https://github.com/firetower-cloud/firetower/commit/1b3db216df4b0d31c660f28a55a48928b8f12793))
* answer the agent's questions instead of permitting them ([8de5b00](https://github.com/firetower-cloud/firetower/commit/8de5b003dca0923d2ae590c5fbf6e13df490c61c))
* attach any file, not only pictures ([df23b19](https://github.com/firetower-cloud/firetower/commit/df23b190bf6d311c62d53a8c8b12aea440c3f7a5))
* carry a conversation between a browser and a headless agent ([ec4bf6d](https://github.com/firetower-cloud/firetower/commit/ec4bf6d90b31c4b0c3c5228a4126973a25b4fe58))
* **core:** read a coding agent's output as a conversation ([0023e75](https://github.com/firetower-cloud/firetower/commit/0023e75e984ef87797e82e15806619a96f0f1ab6))
* get the work out in one press ([449a40b](https://github.com/firetower-cloud/firetower/commit/449a40b1bc0209386e4490eb062273cc0e30669f))
* let the agent stop and ask, and let somebody answer ([3098935](https://github.com/firetower-cloud/firetower/commit/30989353f30a4d1ecc1ea1ee0493c33f2caa405e))
* paste a picture, mention a file, type a command ([8fcd1fa](https://github.com/firetower-cloud/firetower/commit/8fcd1fa1154d0bc6de7462c7b5c231807f12a086))
* tell somebody when a session stops ([56f7c91](https://github.com/firetower-cloud/firetower/commit/56f7c91862fcfa38bd01f62add2c5bbcda15618c))
* **web:** annotate what the agent said, and send the notes together ([06f65cd](https://github.com/firetower-cloud/firetower/commit/06f65cd64f2484a00b4674f52516e1d93119b78c))
* **web:** answer a question in your own words ([bcca365](https://github.com/firetower-cloud/firetower/commit/bcca3657f7ced2ac2b58f82f80c12cd9065b4ee1))
* **web:** give a session a shape you can read before the words ([aec59c8](https://github.com/firetower-cloud/firetower/commit/aec59c804c3cb69f76091965cf45b365044b6982))
* **web:** give the session the whole window, and the bring-up to the chat ([b8b0a46](https://github.com/firetower-cloud/firetower/commit/b8b0a46d97d96ce77945fae438d4cf564a9c5ab1))
* **web:** keep the answer to a question in the transcript ([5d9cf61](https://github.com/firetower-cloud/firetower/commit/5d9cf61ae8a43878b56db87d059bd857df5c0502))
* **web:** let the agent's text arrive at a readable pace ([0515d61](https://github.com/firetower-cloud/firetower/commit/0515d61c0e1261e53b4fe6e1bcb7235ff7fa2826))
* **web:** make attaching an image something you can see ([baa3319](https://github.com/firetower-cloud/firetower/commit/baa3319534e3e9b45090389a0502ba11bfca55b2))
* **web:** mark only what is running or wrong, and clear the fade ([4f7db5b](https://github.com/firetower-cloud/firetower/commit/4f7db5bd55119f2d61ac8f9d9b6a50585fd80efd))
* **web:** no marker for a session that has handed back ([1108e5a](https://github.com/firetower-cloud/firetower/commit/1108e5a4a8137c2d6dd0a560a7d135b434361c76))
* **web:** rename in place, and stop saying the repo twice ([502fcfb](https://github.com/firetower-cloud/firetower/commit/502fcfb3dcbb4a63e310173f79c031d68c7c2b63))
* **web:** render what the agent wrote as it meant it ([0f84b1b](https://github.com/firetower-cloud/firetower/commit/0f84b1ba7e41adcadffd2ec6b8969fad94dd0359))
* **web:** rework the chat's type, surfaces and composer ([d677647](https://github.com/firetower-cloud/firetower/commit/d6776472403a4e12fcc2815c89811f75874e31d1))
* **web:** show a session as a conversation instead of a screen ([7a7c02b](https://github.com/firetower-cloud/firetower/commit/7a7c02b212ad1fb4419e18bd062fe3676a49c335))
* **web:** show what was handed to a subagent ([8da7f5e](https://github.com/firetower-cloud/firetower/commit/8da7f5e791827df04e4774e1c29517f041723f78))
* **web:** type to annotate, and say that Enter keeps it ([34d00d4](https://github.com/firetower-cloud/firetower/commit/34d00d4b8dfd88e775850d45f29d586efc9aca62))
* **web:** what is behind the context ring ([af60af2](https://github.com/firetower-cloud/firetower/commit/af60af20b01052748e0823b6d37fd63c0d6675b0))
* **worker:** supervise a headless agent and hold its pipes ([bb2b1d5](https://github.com/firetower-cloud/firetower/commit/bb2b1d5e2b23ba351c4edf2b82a818aa79d35f91))


### Bug Fixes

* let one thing decide what a session is doing ([031baeb](https://github.com/firetower-cloud/firetower/commit/031baeb326a2a6740187b447f731946b848a5d98))
* make "Always" mean always ([d19f6aa](https://github.com/firetower-cloud/firetower/commit/d19f6aa0c7aac32e35a67ed99f22fb2a2c00116c))
* order the slash commands by what somebody probably wants ([e1dfeb9](https://github.com/firetower-cloud/firetower/commit/e1dfeb9c03016f5e5ce29ca6441c8cf87fcc19af))
* show the picture that was sent, not just the words with it ([276befe](https://github.com/firetower-cloud/firetower/commit/276befe5b837e7c4f06ea4815637133df04aecbe))
* stop asking about everything, and run the biggest model ([bb10160](https://github.com/firetower-cloud/firetower/commit/bb10160bd5001d4cc755be109f0466965ae3259c))
* the session reader knows about the limit event ([34172ae](https://github.com/firetower-cloud/firetower/commit/34172ae422256f6b912c6b6daf119e4f5d9c34cc))
* two things in one turn cannot share an identifier ([f542ef9](https://github.com/firetower-cloud/firetower/commit/f542ef94ce7f059d003a7ab9c04b17daa3a8f302))

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
