# Changelog

## [0.9.1](https://github.com/firetower-cloud/firetower/compare/desktop-v0.9.0...desktop-v0.9.1) (2026-09-17)


### Bug Fixes

* a conversation is read once and kept, not re-streamed on every open ([037ff05](https://github.com/firetower-cloud/firetower/commit/037ff05d0eaf5d0f0a1d5626c309c3f32d4a3766))
* **conversation:** cache session transcripts to eliminate replay on ([70013bf](https://github.com/firetower-cloud/firetower/commit/70013bf27607940fe5aa99e8270d8f895714e3ce))

## [0.9.0](https://github.com/firetower-cloud/firetower/compare/desktop-v0.8.0...desktop-v0.9.0) (2026-09-16)


### Features

* **desktop:** a subscription is connected with its token or a code, and the list says what is left ([74bf4e6](https://github.com/firetower-cloud/firetower/commit/74bf4e6a397ec73dbba6edbea753882dc7ef6572))
* **desktop:** a workspace starts on a named account, never on nothing ([6c13ab2](https://github.com/firetower-cloud/firetower/commit/6c13ab2755f1bb5dd2947d7371cdd101e33861bc))
* **desktop:** switch account any time, and choose what happens at the limit ([a6586c0](https://github.com/firetower-cloud/firetower/commit/a6586c0de4ecac48509755d78a9efc3075912ad9))


### Bug Fixes

* **desktop:** the account line lives under the composer, and the limit editor says what a hand-off is ([5f0e7d7](https://github.com/firetower-cloud/firetower/commit/5f0e7d73169ebe53580eaa1e58f9dbd9adfb7c1f))
* **server:** toggling an agent keeps its credential, and no account is invented ([7535567](https://github.com/firetower-cloud/firetower/commit/753556752f1cfa993a2012c9973f59b70426e578))

## [0.8.0](https://github.com/firetower-cloud/firetower/compare/desktop-v0.7.0...desktop-v0.8.0) (2026-09-16)


### ⚠ BREAKING CHANGES

* **worker:** the worker runs on the machine itself

### Features

* connect the Mac client to a real control plane ([4c4643d](https://github.com/firetower-cloud/firetower/commit/4c4643d649abff6dc5d2578da6fd1ae8004f1b87))
* **desktop:** a chat-led workspace, at desk size ([dad2dc2](https://github.com/firetower-cloud/firetower/commit/dad2dc2e2ccefcd56f6b287df9e3b90b5cf6a79b))
* **desktop:** a native macOS client, on fixtures ([9dc5225](https://github.com/firetower-cloud/firetower/commit/9dc522561d0ac6689ea9062189de78c6f6248cf8))
* **desktop:** a shell in the workspace, and paths that open files ([5866313](https://github.com/firetower-cloud/firetower/commit/58663131286400cf5ac919f9f93319b89ddb7e50))
* **desktop:** a status bar says where a workspace runs ([d4b6914](https://github.com/firetower-cloud/firetower/commit/d4b6914df5824168b302cd773fbac6e1fed84933))
* **desktop:** add an agent to the workspace, and hand it notes ([4e1b2ec](https://github.com/firetower-cloud/firetower/commit/4e1b2ecc307b3790866e7d23e55fcf08f0ab4b4c))
* **desktop:** an open file shows what its edits removed ([1bc1fea](https://github.com/firetower-cloud/firetower/commit/1bc1fea25ab58162a74bc5eed50f81485756fbdb))
* **desktop:** links leave the app, the tree marks what is not committed ([6030ad1](https://github.com/firetower-cloud/firetower/commit/6030ad198c87fca935b29a5f508b00828421f5b9))
* **desktop:** native screens over the web build's vocabulary ([d25b7d6](https://github.com/firetower-cloud/firetower/commit/d25b7d6964998d3c36931e1f4ddbc9d0a914b7cb))
* **desktop:** open files in tabs, the way an editor does ([4f74d94](https://github.com/firetower-cloud/firetower/commit/4f74d94762caec44888f7a2f83eeaa4c9cb2092c))
* **desktop:** preview a session's port, and annotate it ([a8eeac7](https://github.com/firetower-cloud/firetower/commit/a8eeac776141523a9fdfe6f5f72432ae82318799))
* **desktop:** the disk image is an installer again ([917ed47](https://github.com/firetower-cloud/firetower/commit/917ed4751e034e44da5a7dcd7d72163e4a3fa9ee))
* **desktop:** the preview's address follows the page ([1e8974b](https://github.com/firetower-cloud/firetower/commit/1e8974b7b0d7845bfcae469f0cbc57ca67dac627))
* **desktop:** the rail says where each workspace runs, in one icon ([f5652dd](https://github.com/firetower-cloud/firetower/commit/f5652dd86ea56cf89f95a119130449c3b0778c8e))
* **desktop:** the trash ends the workspace, menus on tabs and the rail ([b037360](https://github.com/firetower-cloud/firetower/commit/b0373609e1ab607e20bbd69c8b964a0ff9afb67a))
* **desktop:** the workbench runs on the server's stream ([7409b0d](https://github.com/firetower-cloud/firetower/commit/7409b0de56721a94903a036110996c0768d138e5))
* **desktop:** the working line names the phase ([36b00b1](https://github.com/firetower-cloud/firetower/commit/36b00b19995cbfc3a3a282d69986175a989345f1))
* **desktop:** Windows, the keychain, installers ([10cc003](https://github.com/firetower-cloud/firetower/commit/10cc00344f5adf0710133e1caadf3fd8480ff0be))
* **desktop:** wire the rest of the client to the control plane ([a1b0723](https://github.com/firetower-cloud/firetower/commit/a1b0723e6181c81f2f2a1b34255cfc9e2d13bfaa))
* **desktop:** working is said in lit text ([f24c0d4](https://github.com/firetower-cloud/firetower/commit/f24c0d4a009273ff98efaec513c55871fd93fac6))
* **hosts:** adding a machine carries on to installing the worker ([aada912](https://github.com/firetower-cloud/firetower/commit/aada91244cb00b81ed54b46f07bc076d14000024))
* **hosts:** the agents are on the machine's panel and in the dialogs ([d4e9448](https://github.com/firetower-cloud/firetower/commit/d4e9448c26ffeaba459933ef8fd2e8cdcb5613b4))
* **hosts:** the key is what a person gives a machine; the panel does the rest ([51d5a82](https://github.com/firetower-cloud/firetower/commit/51d5a824d69a6ab766900dc918a206dd906039d4))
* **worker:** the worker runs on the machine itself ([4ffe8e7](https://github.com/firetower-cloud/firetower/commit/4ffe8e7195b3bdc959576e7eee20b7d460dbc359))


### Bug Fixes

* **agents:** stopping a turn asks the agent rather than signalling it ([b7e221c](https://github.com/firetower-cloud/firetower/commit/b7e221c20c995b047c035046664d9f6a5d616199))
* **desktop:** a refused app names the reason it was refused ([0b5145b](https://github.com/firetower-cloud/firetower/commit/0b5145b8734a405417b6f52cd0df6bbc781d6afc))
* **desktop:** a server that refused the app is not called unreachable ([3930337](https://github.com/firetower-cloud/firetower/commit/393033728aefca26e61a8a60f95c5db12631b8e0))
* **desktop:** compile the plugins on every platform ([824c148](https://github.com/firetower-cloud/firetower/commit/824c148874b299f51d5cb31996f003acd63bf5fb))
* **desktop:** diff follows the session, notes on the conversation ([24ff2db](https://github.com/firetower-cloud/firetower/commit/24ff2db9636fdb33dab9675eee2a82d98ae2520e))
* **desktop:** grant the window permission to move itself ([5c7e4a8](https://github.com/firetower-cloud/firetower/commit/5c7e4a81e54363edcf639cb9f772a6653bf69673))
* **desktop:** starting a task on a real server went blank ([4add666](https://github.com/firetower-cloud/firetower/commit/4add666afff35d08a554e937c5213c4ee1f6c102))
* **desktop:** the conversation follows a stream frame by frame ([b74107e](https://github.com/firetower-cloud/firetower/commit/b74107ef14c04c2b752c95c512236b752d7a2754))
* **desktop:** the dashboard's End all asks, then ends ([c4b53dc](https://github.com/firetower-cloud/firetower/commit/c4b53dcc27bfd9d1d379b1e696459135c460c04b))
* **desktop:** the file viewer scrolls, and notes open where you selected ([b42da23](https://github.com/firetower-cloud/firetower/commit/b42da23ab59519727fbe88ccba15a42e7fc12167))
* **desktop:** the new-workspace form asks what NewSession takes ([71f0666](https://github.com/firetower-cloud/firetower/commit/71f06667b3832e71dad82e48beae789666a1378c))
* **desktop:** the private-API feature is declared once, for every target ([63bd432](https://github.com/firetower-cloud/firetower/commit/63bd4323871c2c424e13981c8715468af49d4b7a))
* **desktop:** the repository list is not clipped, and can be searched ([8e5b1c6](https://github.com/firetower-cloud/firetower/commit/8e5b1c6f2a1faec6882363988d74de84b0b94ff9))
* **desktop:** the updater reads a feed of its own ([71a6cc0](https://github.com/firetower-cloud/firetower/commit/71a6cc019d5ad8780df98782ff9ee456673e2c59))
* **hosts:** the by-hand authorized_keys lines use ~ rather than guessing the home directory ([07ebe83](https://github.com/firetower-cloud/firetower/commit/07ebe830842c5986ea7d772fe5fe6e53cbf33db6))

## [0.7.0](https://github.com/firetower-cloud/firetower/compare/desktop-v0.6.0...desktop-v0.7.0) (2026-09-16)


### ⚠ BREAKING CHANGES

* **worker:** the worker runs on the machine itself

### Features

* connect the Mac client to a real control plane ([4c4643d](https://github.com/firetower-cloud/firetower/commit/4c4643d649abff6dc5d2578da6fd1ae8004f1b87))
* **desktop:** a chat-led workspace, at desk size ([dad2dc2](https://github.com/firetower-cloud/firetower/commit/dad2dc2e2ccefcd56f6b287df9e3b90b5cf6a79b))
* **desktop:** a native macOS client, on fixtures ([9dc5225](https://github.com/firetower-cloud/firetower/commit/9dc522561d0ac6689ea9062189de78c6f6248cf8))
* **desktop:** a shell in the workspace, and paths that open files ([5866313](https://github.com/firetower-cloud/firetower/commit/58663131286400cf5ac919f9f93319b89ddb7e50))
* **desktop:** a status bar says where a workspace runs ([d4b6914](https://github.com/firetower-cloud/firetower/commit/d4b6914df5824168b302cd773fbac6e1fed84933))
* **desktop:** add an agent to the workspace, and hand it notes ([4e1b2ec](https://github.com/firetower-cloud/firetower/commit/4e1b2ecc307b3790866e7d23e55fcf08f0ab4b4c))
* **desktop:** an open file shows what its edits removed ([1bc1fea](https://github.com/firetower-cloud/firetower/commit/1bc1fea25ab58162a74bc5eed50f81485756fbdb))
* **desktop:** links leave the app, the tree marks what is not committed ([6030ad1](https://github.com/firetower-cloud/firetower/commit/6030ad198c87fca935b29a5f508b00828421f5b9))
* **desktop:** native screens over the web build's vocabulary ([d25b7d6](https://github.com/firetower-cloud/firetower/commit/d25b7d6964998d3c36931e1f4ddbc9d0a914b7cb))
* **desktop:** open files in tabs, the way an editor does ([4f74d94](https://github.com/firetower-cloud/firetower/commit/4f74d94762caec44888f7a2f83eeaa4c9cb2092c))
* **desktop:** preview a session's port, and annotate it ([a8eeac7](https://github.com/firetower-cloud/firetower/commit/a8eeac776141523a9fdfe6f5f72432ae82318799))
* **desktop:** the disk image is an installer again ([917ed47](https://github.com/firetower-cloud/firetower/commit/917ed4751e034e44da5a7dcd7d72163e4a3fa9ee))
* **desktop:** the preview's address follows the page ([1e8974b](https://github.com/firetower-cloud/firetower/commit/1e8974b7b0d7845bfcae469f0cbc57ca67dac627))
* **desktop:** the rail says where each workspace runs, in one icon ([f5652dd](https://github.com/firetower-cloud/firetower/commit/f5652dd86ea56cf89f95a119130449c3b0778c8e))
* **desktop:** the trash ends the workspace, menus on tabs and the rail ([b037360](https://github.com/firetower-cloud/firetower/commit/b0373609e1ab607e20bbd69c8b964a0ff9afb67a))
* **desktop:** the workbench runs on the server's stream ([7409b0d](https://github.com/firetower-cloud/firetower/commit/7409b0de56721a94903a036110996c0768d138e5))
* **desktop:** the working line names the phase ([36b00b1](https://github.com/firetower-cloud/firetower/commit/36b00b19995cbfc3a3a282d69986175a989345f1))
* **desktop:** Windows, the keychain, installers ([10cc003](https://github.com/firetower-cloud/firetower/commit/10cc00344f5adf0710133e1caadf3fd8480ff0be))
* **desktop:** wire the rest of the client to the control plane ([a1b0723](https://github.com/firetower-cloud/firetower/commit/a1b0723e6181c81f2f2a1b34255cfc9e2d13bfaa))
* **desktop:** working is said in lit text ([f24c0d4](https://github.com/firetower-cloud/firetower/commit/f24c0d4a009273ff98efaec513c55871fd93fac6))
* **hosts:** adding a machine carries on to installing the worker ([aada912](https://github.com/firetower-cloud/firetower/commit/aada91244cb00b81ed54b46f07bc076d14000024))
* **hosts:** the agents are on the machine's panel and in the dialogs ([d4e9448](https://github.com/firetower-cloud/firetower/commit/d4e9448c26ffeaba459933ef8fd2e8cdcb5613b4))
* **hosts:** the key is what a person gives a machine; the panel does the rest ([51d5a82](https://github.com/firetower-cloud/firetower/commit/51d5a824d69a6ab766900dc918a206dd906039d4))
* **worker:** the worker runs on the machine itself ([4ffe8e7](https://github.com/firetower-cloud/firetower/commit/4ffe8e7195b3bdc959576e7eee20b7d460dbc359))


### Bug Fixes

* **agents:** stopping a turn asks the agent rather than signalling it ([b7e221c](https://github.com/firetower-cloud/firetower/commit/b7e221c20c995b047c035046664d9f6a5d616199))
* **desktop:** a refused app names the reason it was refused ([0b5145b](https://github.com/firetower-cloud/firetower/commit/0b5145b8734a405417b6f52cd0df6bbc781d6afc))
* **desktop:** a server that refused the app is not called unreachable ([3930337](https://github.com/firetower-cloud/firetower/commit/393033728aefca26e61a8a60f95c5db12631b8e0))
* **desktop:** compile the plugins on every platform ([824c148](https://github.com/firetower-cloud/firetower/commit/824c148874b299f51d5cb31996f003acd63bf5fb))
* **desktop:** diff follows the session, notes on the conversation ([24ff2db](https://github.com/firetower-cloud/firetower/commit/24ff2db9636fdb33dab9675eee2a82d98ae2520e))
* **desktop:** grant the window permission to move itself ([5c7e4a8](https://github.com/firetower-cloud/firetower/commit/5c7e4a81e54363edcf639cb9f772a6653bf69673))
* **desktop:** starting a task on a real server went blank ([4add666](https://github.com/firetower-cloud/firetower/commit/4add666afff35d08a554e937c5213c4ee1f6c102))
* **desktop:** the conversation follows a stream frame by frame ([b74107e](https://github.com/firetower-cloud/firetower/commit/b74107ef14c04c2b752c95c512236b752d7a2754))
* **desktop:** the dashboard's End all asks, then ends ([c4b53dc](https://github.com/firetower-cloud/firetower/commit/c4b53dcc27bfd9d1d379b1e696459135c460c04b))
* **desktop:** the file viewer scrolls, and notes open where you selected ([b42da23](https://github.com/firetower-cloud/firetower/commit/b42da23ab59519727fbe88ccba15a42e7fc12167))
* **desktop:** the new-workspace form asks what NewSession takes ([71f0666](https://github.com/firetower-cloud/firetower/commit/71f06667b3832e71dad82e48beae789666a1378c))
* **desktop:** the private-API feature is declared once, for every target ([63bd432](https://github.com/firetower-cloud/firetower/commit/63bd4323871c2c424e13981c8715468af49d4b7a))
* **desktop:** the repository list is not clipped, and can be searched ([8e5b1c6](https://github.com/firetower-cloud/firetower/commit/8e5b1c6f2a1faec6882363988d74de84b0b94ff9))
* **desktop:** the updater reads a feed of its own ([71a6cc0](https://github.com/firetower-cloud/firetower/commit/71a6cc019d5ad8780df98782ff9ee456673e2c59))
* **hosts:** the by-hand authorized_keys lines use ~ rather than guessing the home directory ([07ebe83](https://github.com/firetower-cloud/firetower/commit/07ebe830842c5986ea7d772fe5fe6e53cbf33db6))

## [0.6.0](https://github.com/firetower-cloud/firetower/compare/desktop-v0.5.0...desktop-v0.6.0) (2026-09-16)


### ⚠ BREAKING CHANGES

* **worker:** the worker runs on the machine itself

### Features

* connect the Mac client to a real control plane ([4c4643d](https://github.com/firetower-cloud/firetower/commit/4c4643d649abff6dc5d2578da6fd1ae8004f1b87))
* **desktop:** a chat-led workspace, at desk size ([dad2dc2](https://github.com/firetower-cloud/firetower/commit/dad2dc2e2ccefcd56f6b287df9e3b90b5cf6a79b))
* **desktop:** a native macOS client, on fixtures ([9dc5225](https://github.com/firetower-cloud/firetower/commit/9dc522561d0ac6689ea9062189de78c6f6248cf8))
* **desktop:** a shell in the workspace, and paths that open files ([5866313](https://github.com/firetower-cloud/firetower/commit/58663131286400cf5ac919f9f93319b89ddb7e50))
* **desktop:** a status bar says where a workspace runs ([d4b6914](https://github.com/firetower-cloud/firetower/commit/d4b6914df5824168b302cd773fbac6e1fed84933))
* **desktop:** add an agent to the workspace, and hand it notes ([4e1b2ec](https://github.com/firetower-cloud/firetower/commit/4e1b2ecc307b3790866e7d23e55fcf08f0ab4b4c))
* **desktop:** an open file shows what its edits removed ([1bc1fea](https://github.com/firetower-cloud/firetower/commit/1bc1fea25ab58162a74bc5eed50f81485756fbdb))
* **desktop:** links leave the app, the tree marks what is not committed ([6030ad1](https://github.com/firetower-cloud/firetower/commit/6030ad198c87fca935b29a5f508b00828421f5b9))
* **desktop:** native screens over the web build's vocabulary ([d25b7d6](https://github.com/firetower-cloud/firetower/commit/d25b7d6964998d3c36931e1f4ddbc9d0a914b7cb))
* **desktop:** open files in tabs, the way an editor does ([4f74d94](https://github.com/firetower-cloud/firetower/commit/4f74d94762caec44888f7a2f83eeaa4c9cb2092c))
* **desktop:** preview a session's port, and annotate it ([a8eeac7](https://github.com/firetower-cloud/firetower/commit/a8eeac776141523a9fdfe6f5f72432ae82318799))
* **desktop:** the disk image is an installer again ([917ed47](https://github.com/firetower-cloud/firetower/commit/917ed4751e034e44da5a7dcd7d72163e4a3fa9ee))
* **desktop:** the preview's address follows the page ([1e8974b](https://github.com/firetower-cloud/firetower/commit/1e8974b7b0d7845bfcae469f0cbc57ca67dac627))
* **desktop:** the rail says where each workspace runs, in one icon ([f5652dd](https://github.com/firetower-cloud/firetower/commit/f5652dd86ea56cf89f95a119130449c3b0778c8e))
* **desktop:** the trash ends the workspace, menus on tabs and the rail ([b037360](https://github.com/firetower-cloud/firetower/commit/b0373609e1ab607e20bbd69c8b964a0ff9afb67a))
* **desktop:** the workbench runs on the server's stream ([7409b0d](https://github.com/firetower-cloud/firetower/commit/7409b0de56721a94903a036110996c0768d138e5))
* **desktop:** the working line names the phase ([36b00b1](https://github.com/firetower-cloud/firetower/commit/36b00b19995cbfc3a3a282d69986175a989345f1))
* **desktop:** Windows, the keychain, installers ([10cc003](https://github.com/firetower-cloud/firetower/commit/10cc00344f5adf0710133e1caadf3fd8480ff0be))
* **desktop:** wire the rest of the client to the control plane ([a1b0723](https://github.com/firetower-cloud/firetower/commit/a1b0723e6181c81f2f2a1b34255cfc9e2d13bfaa))
* **desktop:** working is said in lit text ([f24c0d4](https://github.com/firetower-cloud/firetower/commit/f24c0d4a009273ff98efaec513c55871fd93fac6))
* **hosts:** adding a machine carries on to installing the worker ([aada912](https://github.com/firetower-cloud/firetower/commit/aada91244cb00b81ed54b46f07bc076d14000024))
* **hosts:** the agents are on the machine's panel and in the dialogs ([d4e9448](https://github.com/firetower-cloud/firetower/commit/d4e9448c26ffeaba459933ef8fd2e8cdcb5613b4))
* **hosts:** the key is what a person gives a machine; the panel does the rest ([51d5a82](https://github.com/firetower-cloud/firetower/commit/51d5a824d69a6ab766900dc918a206dd906039d4))
* **worker:** the worker runs on the machine itself ([4ffe8e7](https://github.com/firetower-cloud/firetower/commit/4ffe8e7195b3bdc959576e7eee20b7d460dbc359))


### Bug Fixes

* **agents:** stopping a turn asks the agent rather than signalling it ([b7e221c](https://github.com/firetower-cloud/firetower/commit/b7e221c20c995b047c035046664d9f6a5d616199))
* **desktop:** a refused app names the reason it was refused ([0b5145b](https://github.com/firetower-cloud/firetower/commit/0b5145b8734a405417b6f52cd0df6bbc781d6afc))
* **desktop:** a server that refused the app is not called unreachable ([3930337](https://github.com/firetower-cloud/firetower/commit/393033728aefca26e61a8a60f95c5db12631b8e0))
* **desktop:** compile the plugins on every platform ([824c148](https://github.com/firetower-cloud/firetower/commit/824c148874b299f51d5cb31996f003acd63bf5fb))
* **desktop:** diff follows the session, notes on the conversation ([24ff2db](https://github.com/firetower-cloud/firetower/commit/24ff2db9636fdb33dab9675eee2a82d98ae2520e))
* **desktop:** grant the window permission to move itself ([5c7e4a8](https://github.com/firetower-cloud/firetower/commit/5c7e4a81e54363edcf639cb9f772a6653bf69673))
* **desktop:** starting a task on a real server went blank ([4add666](https://github.com/firetower-cloud/firetower/commit/4add666afff35d08a554e937c5213c4ee1f6c102))
* **desktop:** the conversation follows a stream frame by frame ([b74107e](https://github.com/firetower-cloud/firetower/commit/b74107ef14c04c2b752c95c512236b752d7a2754))
* **desktop:** the dashboard's End all asks, then ends ([c4b53dc](https://github.com/firetower-cloud/firetower/commit/c4b53dcc27bfd9d1d379b1e696459135c460c04b))
* **desktop:** the file viewer scrolls, and notes open where you selected ([b42da23](https://github.com/firetower-cloud/firetower/commit/b42da23ab59519727fbe88ccba15a42e7fc12167))
* **desktop:** the new-workspace form asks what NewSession takes ([71f0666](https://github.com/firetower-cloud/firetower/commit/71f06667b3832e71dad82e48beae789666a1378c))
* **desktop:** the private-API feature is declared once, for every target ([63bd432](https://github.com/firetower-cloud/firetower/commit/63bd4323871c2c424e13981c8715468af49d4b7a))
* **desktop:** the repository list is not clipped, and can be searched ([8e5b1c6](https://github.com/firetower-cloud/firetower/commit/8e5b1c6f2a1faec6882363988d74de84b0b94ff9))
* **desktop:** the updater reads a feed of its own ([71a6cc0](https://github.com/firetower-cloud/firetower/commit/71a6cc019d5ad8780df98782ff9ee456673e2c59))
* **hosts:** the by-hand authorized_keys lines use ~ rather than guessing the home directory ([07ebe83](https://github.com/firetower-cloud/firetower/commit/07ebe830842c5986ea7d772fe5fe6e53cbf33db6))

## [0.5.0](https://github.com/firetower-cloud/firetower/compare/desktop-v0.4.0...desktop-v0.5.0) (2026-09-16)


### ⚠ BREAKING CHANGES

* **worker:** the worker runs on the machine itself

### Features

* connect the Mac client to a real control plane ([4c4643d](https://github.com/firetower-cloud/firetower/commit/4c4643d649abff6dc5d2578da6fd1ae8004f1b87))
* **desktop:** a chat-led workspace, at desk size ([dad2dc2](https://github.com/firetower-cloud/firetower/commit/dad2dc2e2ccefcd56f6b287df9e3b90b5cf6a79b))
* **desktop:** a native macOS client, on fixtures ([9dc5225](https://github.com/firetower-cloud/firetower/commit/9dc522561d0ac6689ea9062189de78c6f6248cf8))
* **desktop:** a shell in the workspace, and paths that open files ([5866313](https://github.com/firetower-cloud/firetower/commit/58663131286400cf5ac919f9f93319b89ddb7e50))
* **desktop:** a status bar says where a workspace runs ([d4b6914](https://github.com/firetower-cloud/firetower/commit/d4b6914df5824168b302cd773fbac6e1fed84933))
* **desktop:** add an agent to the workspace, and hand it notes ([4e1b2ec](https://github.com/firetower-cloud/firetower/commit/4e1b2ecc307b3790866e7d23e55fcf08f0ab4b4c))
* **desktop:** an open file shows what its edits removed ([1bc1fea](https://github.com/firetower-cloud/firetower/commit/1bc1fea25ab58162a74bc5eed50f81485756fbdb))
* **desktop:** links leave the app, the tree marks what is not committed ([6030ad1](https://github.com/firetower-cloud/firetower/commit/6030ad198c87fca935b29a5f508b00828421f5b9))
* **desktop:** native screens over the web build's vocabulary ([d25b7d6](https://github.com/firetower-cloud/firetower/commit/d25b7d6964998d3c36931e1f4ddbc9d0a914b7cb))
* **desktop:** open files in tabs, the way an editor does ([4f74d94](https://github.com/firetower-cloud/firetower/commit/4f74d94762caec44888f7a2f83eeaa4c9cb2092c))
* **desktop:** preview a session's port, and annotate it ([a8eeac7](https://github.com/firetower-cloud/firetower/commit/a8eeac776141523a9fdfe6f5f72432ae82318799))
* **desktop:** the disk image is an installer again ([917ed47](https://github.com/firetower-cloud/firetower/commit/917ed4751e034e44da5a7dcd7d72163e4a3fa9ee))
* **desktop:** the preview's address follows the page ([1e8974b](https://github.com/firetower-cloud/firetower/commit/1e8974b7b0d7845bfcae469f0cbc57ca67dac627))
* **desktop:** the rail says where each workspace runs, in one icon ([f5652dd](https://github.com/firetower-cloud/firetower/commit/f5652dd86ea56cf89f95a119130449c3b0778c8e))
* **desktop:** the trash ends the workspace, menus on tabs and the rail ([b037360](https://github.com/firetower-cloud/firetower/commit/b0373609e1ab607e20bbd69c8b964a0ff9afb67a))
* **desktop:** the workbench runs on the server's stream ([7409b0d](https://github.com/firetower-cloud/firetower/commit/7409b0de56721a94903a036110996c0768d138e5))
* **desktop:** the working line names the phase ([36b00b1](https://github.com/firetower-cloud/firetower/commit/36b00b19995cbfc3a3a282d69986175a989345f1))
* **desktop:** Windows, the keychain, installers ([10cc003](https://github.com/firetower-cloud/firetower/commit/10cc00344f5adf0710133e1caadf3fd8480ff0be))
* **desktop:** wire the rest of the client to the control plane ([a1b0723](https://github.com/firetower-cloud/firetower/commit/a1b0723e6181c81f2f2a1b34255cfc9e2d13bfaa))
* **desktop:** working is said in lit text ([f24c0d4](https://github.com/firetower-cloud/firetower/commit/f24c0d4a009273ff98efaec513c55871fd93fac6))
* **hosts:** adding a machine carries on to installing the worker ([aada912](https://github.com/firetower-cloud/firetower/commit/aada91244cb00b81ed54b46f07bc076d14000024))
* **hosts:** the agents are on the machine's panel and in the dialogs ([d4e9448](https://github.com/firetower-cloud/firetower/commit/d4e9448c26ffeaba459933ef8fd2e8cdcb5613b4))
* **hosts:** the key is what a person gives a machine; the panel does the rest ([51d5a82](https://github.com/firetower-cloud/firetower/commit/51d5a824d69a6ab766900dc918a206dd906039d4))
* **worker:** the worker runs on the machine itself ([4ffe8e7](https://github.com/firetower-cloud/firetower/commit/4ffe8e7195b3bdc959576e7eee20b7d460dbc359))


### Bug Fixes

* **agents:** stopping a turn asks the agent rather than signalling it ([b7e221c](https://github.com/firetower-cloud/firetower/commit/b7e221c20c995b047c035046664d9f6a5d616199))
* **desktop:** a refused app names the reason it was refused ([0b5145b](https://github.com/firetower-cloud/firetower/commit/0b5145b8734a405417b6f52cd0df6bbc781d6afc))
* **desktop:** a server that refused the app is not called unreachable ([3930337](https://github.com/firetower-cloud/firetower/commit/393033728aefca26e61a8a60f95c5db12631b8e0))
* **desktop:** compile the plugins on every platform ([824c148](https://github.com/firetower-cloud/firetower/commit/824c148874b299f51d5cb31996f003acd63bf5fb))
* **desktop:** diff follows the session, notes on the conversation ([24ff2db](https://github.com/firetower-cloud/firetower/commit/24ff2db9636fdb33dab9675eee2a82d98ae2520e))
* **desktop:** grant the window permission to move itself ([5c7e4a8](https://github.com/firetower-cloud/firetower/commit/5c7e4a81e54363edcf639cb9f772a6653bf69673))
* **desktop:** starting a task on a real server went blank ([4add666](https://github.com/firetower-cloud/firetower/commit/4add666afff35d08a554e937c5213c4ee1f6c102))
* **desktop:** the conversation follows a stream frame by frame ([b74107e](https://github.com/firetower-cloud/firetower/commit/b74107ef14c04c2b752c95c512236b752d7a2754))
* **desktop:** the dashboard's End all asks, then ends ([c4b53dc](https://github.com/firetower-cloud/firetower/commit/c4b53dcc27bfd9d1d379b1e696459135c460c04b))
* **desktop:** the file viewer scrolls, and notes open where you selected ([b42da23](https://github.com/firetower-cloud/firetower/commit/b42da23ab59519727fbe88ccba15a42e7fc12167))
* **desktop:** the new-workspace form asks what NewSession takes ([71f0666](https://github.com/firetower-cloud/firetower/commit/71f06667b3832e71dad82e48beae789666a1378c))
* **desktop:** the private-API feature is declared once, for every target ([63bd432](https://github.com/firetower-cloud/firetower/commit/63bd4323871c2c424e13981c8715468af49d4b7a))
* **desktop:** the repository list is not clipped, and can be searched ([8e5b1c6](https://github.com/firetower-cloud/firetower/commit/8e5b1c6f2a1faec6882363988d74de84b0b94ff9))
* **desktop:** the updater reads a feed of its own ([71a6cc0](https://github.com/firetower-cloud/firetower/commit/71a6cc019d5ad8780df98782ff9ee456673e2c59))
* **hosts:** the by-hand authorized_keys lines use ~ rather than guessing the home directory ([07ebe83](https://github.com/firetower-cloud/firetower/commit/07ebe830842c5986ea7d772fe5fe6e53cbf33db6))

## [0.4.0](https://github.com/firetower-cloud/firetower/compare/desktop-v0.3.3...desktop-v0.4.0) (2026-09-16)


### ⚠ BREAKING CHANGES

* **worker:** the worker runs on the machine itself

### Features

* **hosts:** adding a machine carries on to installing the worker ([aada912](https://github.com/firetower-cloud/firetower/commit/aada91244cb00b81ed54b46f07bc076d14000024))
* **hosts:** the agents are on the machine's panel and in the dialogs ([d4e9448](https://github.com/firetower-cloud/firetower/commit/d4e9448c26ffeaba459933ef8fd2e8cdcb5613b4))
* **hosts:** the key is what a person gives a machine; the panel does the rest ([51d5a82](https://github.com/firetower-cloud/firetower/commit/51d5a824d69a6ab766900dc918a206dd906039d4))
* **worker:** the worker runs on the machine itself ([4ffe8e7](https://github.com/firetower-cloud/firetower/commit/4ffe8e7195b3bdc959576e7eee20b7d460dbc359))


### Bug Fixes

* **hosts:** the by-hand authorized_keys lines use ~ rather than guessing the home directory ([07ebe83](https://github.com/firetower-cloud/firetower/commit/07ebe830842c5986ea7d772fe5fe6e53cbf33db6))

## [0.3.3](https://github.com/firetower-cloud/firetower/compare/desktop-v0.3.2...desktop-v0.3.3) (2026-09-15)


### Bug Fixes

* **desktop:** the updater reads a feed of its own ([71a6cc0](https://github.com/firetower-cloud/firetower/commit/71a6cc019d5ad8780df98782ff9ee456673e2c59))

## [0.3.2](https://github.com/firetower-cloud/firetower/compare/desktop-v0.3.1...desktop-v0.3.2) (2026-09-15)


### Bug Fixes

* **agents:** stopping a turn asks the agent rather than signalling it ([b7e221c](https://github.com/firetower-cloud/firetower/commit/b7e221c20c995b047c035046664d9f6a5d616199))
* **desktop:** a refused app names the reason it was refused ([0b5145b](https://github.com/firetower-cloud/firetower/commit/0b5145b8734a405417b6f52cd0df6bbc781d6afc))

## [0.3.1](https://github.com/firetower-cloud/firetower/compare/desktop-v0.3.0...desktop-v0.3.1) (2026-09-14)


### Bug Fixes

* **desktop:** a server that refused the app is not called unreachable ([3930337](https://github.com/firetower-cloud/firetower/commit/393033728aefca26e61a8a60f95c5db12631b8e0))

## [0.3.0](https://github.com/firetower-cloud/firetower/compare/desktop-v0.2.0...desktop-v0.3.0) (2026-09-14)


### Features

* **desktop:** the disk image is an installer again ([917ed47](https://github.com/firetower-cloud/firetower/commit/917ed4751e034e44da5a7dcd7d72163e4a3fa9ee))

## 0.2.0 (2026-09-14)


### Features

* connect the Mac client to a real control plane ([4c4643d](https://github.com/firetower-cloud/firetower/commit/4c4643d649abff6dc5d2578da6fd1ae8004f1b87))
* **desktop:** a chat-led workspace, at desk size ([dad2dc2](https://github.com/firetower-cloud/firetower/commit/dad2dc2e2ccefcd56f6b287df9e3b90b5cf6a79b))
* **desktop:** a native macOS client, on fixtures ([9dc5225](https://github.com/firetower-cloud/firetower/commit/9dc522561d0ac6689ea9062189de78c6f6248cf8))
* **desktop:** a shell in the workspace, and paths that open files ([5866313](https://github.com/firetower-cloud/firetower/commit/58663131286400cf5ac919f9f93319b89ddb7e50))
* **desktop:** a status bar says where a workspace runs ([d4b6914](https://github.com/firetower-cloud/firetower/commit/d4b6914df5824168b302cd773fbac6e1fed84933))
* **desktop:** add an agent to the workspace, and hand it notes ([4e1b2ec](https://github.com/firetower-cloud/firetower/commit/4e1b2ecc307b3790866e7d23e55fcf08f0ab4b4c))
* **desktop:** an open file shows what its edits removed ([1bc1fea](https://github.com/firetower-cloud/firetower/commit/1bc1fea25ab58162a74bc5eed50f81485756fbdb))
* **desktop:** links leave the app, the tree marks what is not committed ([6030ad1](https://github.com/firetower-cloud/firetower/commit/6030ad198c87fca935b29a5f508b00828421f5b9))
* **desktop:** native screens over the web build's vocabulary ([d25b7d6](https://github.com/firetower-cloud/firetower/commit/d25b7d6964998d3c36931e1f4ddbc9d0a914b7cb))
* **desktop:** open files in tabs, the way an editor does ([4f74d94](https://github.com/firetower-cloud/firetower/commit/4f74d94762caec44888f7a2f83eeaa4c9cb2092c))
* **desktop:** preview a session's port, and annotate it ([a8eeac7](https://github.com/firetower-cloud/firetower/commit/a8eeac776141523a9fdfe6f5f72432ae82318799))
* **desktop:** the preview's address follows the page ([1e8974b](https://github.com/firetower-cloud/firetower/commit/1e8974b7b0d7845bfcae469f0cbc57ca67dac627))
* **desktop:** the rail says where each workspace runs, in one icon ([f5652dd](https://github.com/firetower-cloud/firetower/commit/f5652dd86ea56cf89f95a119130449c3b0778c8e))
* **desktop:** the trash ends the workspace, menus on tabs and the rail ([b037360](https://github.com/firetower-cloud/firetower/commit/b0373609e1ab607e20bbd69c8b964a0ff9afb67a))
* **desktop:** the workbench runs on the server's stream ([7409b0d](https://github.com/firetower-cloud/firetower/commit/7409b0de56721a94903a036110996c0768d138e5))
* **desktop:** the working line names the phase ([36b00b1](https://github.com/firetower-cloud/firetower/commit/36b00b19995cbfc3a3a282d69986175a989345f1))
* **desktop:** Windows, the keychain, installers ([10cc003](https://github.com/firetower-cloud/firetower/commit/10cc00344f5adf0710133e1caadf3fd8480ff0be))
* **desktop:** wire the rest of the client to the control plane ([a1b0723](https://github.com/firetower-cloud/firetower/commit/a1b0723e6181c81f2f2a1b34255cfc9e2d13bfaa))
* **desktop:** working is said in lit text ([f24c0d4](https://github.com/firetower-cloud/firetower/commit/f24c0d4a009273ff98efaec513c55871fd93fac6))


### Bug Fixes

* **desktop:** compile the plugins on every platform ([824c148](https://github.com/firetower-cloud/firetower/commit/824c148874b299f51d5cb31996f003acd63bf5fb))
* **desktop:** diff follows the session, notes on the conversation ([24ff2db](https://github.com/firetower-cloud/firetower/commit/24ff2db9636fdb33dab9675eee2a82d98ae2520e))
* **desktop:** grant the window permission to move itself ([5c7e4a8](https://github.com/firetower-cloud/firetower/commit/5c7e4a81e54363edcf639cb9f772a6653bf69673))
* **desktop:** starting a task on a real server went blank ([4add666](https://github.com/firetower-cloud/firetower/commit/4add666afff35d08a554e937c5213c4ee1f6c102))
* **desktop:** the conversation follows a stream frame by frame ([b74107e](https://github.com/firetower-cloud/firetower/commit/b74107ef14c04c2b752c95c512236b752d7a2754))
* **desktop:** the dashboard's End all asks, then ends ([c4b53dc](https://github.com/firetower-cloud/firetower/commit/c4b53dcc27bfd9d1d379b1e696459135c460c04b))
* **desktop:** the file viewer scrolls, and notes open where you selected ([b42da23](https://github.com/firetower-cloud/firetower/commit/b42da23ab59519727fbe88ccba15a42e7fc12167))
* **desktop:** the new-workspace form asks what NewSession takes ([71f0666](https://github.com/firetower-cloud/firetower/commit/71f06667b3832e71dad82e48beae789666a1378c))
* **desktop:** the private-API feature is declared once, for every target ([63bd432](https://github.com/firetower-cloud/firetower/commit/63bd4323871c2c424e13981c8715468af49d4b7a))
* **desktop:** the repository list is not clipped, and can be searched ([8e5b1c6](https://github.com/firetower-cloud/firetower/commit/8e5b1c6f2a1faec6882363988d74de84b0b94ff9))
