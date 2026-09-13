# Changelog

## [0.9.0](https://github.com/rambaarde/nacre/compare/v0.8.0...v0.9.0) (2026-09-13)


### Features

* **memory:** cross-project lessons, plus lint and sleep ([a8a47ca](https://github.com/rambaarde/nacre/commit/a8a47ca42e3e6dd7ce922d5f6d7adcdd58360334))
* **memory:** cross-project lessons, plus lint and sleep ([3f78ce6](https://github.com/rambaarde/nacre/commit/3f78ce645f15fca2c3d52daaa20f3e56f9e1616b))
* **memory:** cross-project lessons, plus lint and sleep ([6121239](https://github.com/rambaarde/nacre/commit/6121239eb75917b8567b3d5e8a392138e71fe83c))
* **portal:** live force simulation on the seam graph ([ecc1e0e](https://github.com/rambaarde/nacre/commit/ecc1e0ece42ac425384ba716dba782478d71a565))
* **portal:** live force simulation on the seam graph ([08fc652](https://github.com/rambaarde/nacre/commit/08fc6527345149e8a467dfc4f79ca34198a7af2b))
* **portal:** live force simulation on the seam graph ([54d5796](https://github.com/rambaarde/nacre/commit/54d5796b6b5fbbc02d152ae2d8a3323570742d01))
* **portal:** live graph filter + pinnable sheet, and env-tunable search caps ([15f6816](https://github.com/rambaarde/nacre/commit/15f6816667b95ecb7bf8f1212d4203f1b44c4c9d))
* **portal:** live graph filter + pinnable sheet, env-tunable search caps, and tests ([8ddd135](https://github.com/rambaarde/nacre/commit/8ddd135d753a02be36dba87ac4a50609480f141f))
* **portal:** live node filter and a pinnable sheet on the seam graph ([666e85c](https://github.com/rambaarde/nacre/commit/666e85ccc587732ff31a88beba8865906c39c750))
* **portal:** the seam — an entity graph in nacre serve ([cee0696](https://github.com/rambaarde/nacre/commit/cee069680c24e16e98fe8b679e5c637aa714f634))
* **portal:** the seam — an entity graph in nacre serve ([f1e22f5](https://github.com/rambaarde/nacre/commit/f1e22f50233d3cf4033618117ac89bd60224db04))
* **portal:** the seam — an entity graph in nacre serve ([e51fa2d](https://github.com/rambaarde/nacre/commit/e51fa2d5f4788cddeb2fe026162458343a7c51fb))
* **search:** make the CLI result caps env-tunable, and say what is hidden ([fda610e](https://github.com/rambaarde/nacre/commit/fda610edf3437345fd50331e8b62394141a15bc9))


### Bug Fixes

* **portal:** force-directed layout for the seam, not three columns ([3d662af](https://github.com/rambaarde/nacre/commit/3d662afddadf7e2df5bf81687b71826bcc9474c1))
* **portal:** force-directed layout for the seam, not three columns ([49e01e3](https://github.com/rambaarde/nacre/commit/49e01e34a67a8e0e416d949159b42418e06d16e9))
* **portal:** force-directed layout for the seam, not three columns ([d5ad3de](https://github.com/rambaarde/nacre/commit/d5ad3de720ea41b6e4655c22773acc8b8901e32d))
* **portal:** the graph collapsed, and the nodes had no colour ([c88e3ca](https://github.com/rambaarde/nacre/commit/c88e3caf21c2a73e168ef6b8c4d24e6a688d9267))
* **portal:** the graph collapsed, and the nodes had no colour ([f1ac7a2](https://github.com/rambaarde/nacre/commit/f1ac7a25fe9129690642e48252c8920362d14601))
* **portal:** the graph collapsed, and the nodes had no colour ([8378ab0](https://github.com/rambaarde/nacre/commit/8378ab0a56759b100a10334580bffae7e9558982))

## [0.8.0](https://github.com/rambaarde/nacre/compare/v0.7.1...v0.8.0) (2026-08-10)


### ⚠ BREAKING CHANGES

* **cli:** alias is nac, not ncr
* **name:** the package name, both binaries, the binding file and the environment variables are renamed with no fallback. Reinstall as nacre-cli and rename .varve.yml to .nacre.yml.

### Features

* **name:** rename varve to nacre ([f7a62cd](https://github.com/rambaarde/nacre/commit/f7a62cd1a88410e4f863f98fb0de67ca2e8ad882))


### Bug Fixes

* **cli:** alias is nac, not ncr ([02bcec4](https://github.com/rambaarde/nacre/commit/02bcec4ebcb2f670edb62bff1fdd755afc73a700))
* **docs:** bust the cached portal GIF, and keep the version pre-1.0 ([c84fa24](https://github.com/rambaarde/nacre/commit/c84fa24ae3bcac21c036622b987b6b810ec13024))
* **docs:** bust the cached portal GIF, and keep the version pre-1.0 ([6bfb3d4](https://github.com/rambaarde/nacre/commit/6bfb3d4e7fa6c195db7e6d5d2322bf510c45aa0c))
* **docs:** bust the cached portal GIF, and keep the version pre-1.0 ([f16573c](https://github.com/rambaarde/nacre/commit/f16573cd27ce4865709f41461604723ba75885ec))


### Reverts

* pull the session GIF, its opening frames leak account details ([ba3cfff](https://github.com/rambaarde/nacre/commit/ba3cfffd190d37e85e2e0af9a3c56dc038ceba89))
* pull the session GIF, its opening frames leak account details ([b677c40](https://github.com/rambaarde/nacre/commit/b677c4033a71ce28f49e168325522f46ab577b57))

## [0.7.1](https://github.com/rambaarde/varve/compare/v0.7.0...v0.7.1) (2026-08-07)


### Bug Fixes

* **store:** a missing local memory is not a permissions problem ([c4dd4f5](https://github.com/rambaarde/varve/commit/c4dd4f577931ffd58584ab8d09b69e315d2c0b5e))

## [0.7.0](https://github.com/rambaarde/varve/compare/v0.6.1...v0.7.0) (2026-08-07)


### Features

* **hook:** load the memory without anyone remembering to ([18bcbf4](https://github.com/rambaarde/varve/commit/18bcbf462983e24fb05acdeb8979cd10b1a718e8))
* **hook:** load the memory without anyone remembering to ([6d72060](https://github.com/rambaarde/varve/commit/6d72060ddf5d4ba0f1518e4af594609ac5d78fa5))

## [0.6.1](https://github.com/rambaarde/varve/compare/v0.6.0...v0.6.1) (2026-08-07)


### Bug Fixes

* **onboarding:** the memory is created on main, and empty is not malformed ([3b25fd1](https://github.com/rambaarde/varve/commit/3b25fd1a523d4d65354cce1464ecd42bba64f02a))
* **onboarding:** the memory is created on main, and empty is not malformed ([55e994b](https://github.com/rambaarde/varve/commit/55e994bcbda64c70c922bf75e34a5a8ebd976282))

## [0.6.0](https://github.com/rambaarde/varve/compare/v0.5.4...v0.6.0) (2026-08-06)


### Features

* **invite:** remove the one step that lived in a browser ([3be5133](https://github.com/rambaarde/varve/commit/3be51332f5fd8fce018af198f451982e6c6ad7d0))
* **invite:** remove the one step that lived in a browser ([3f7e1d2](https://github.com/rambaarde/varve/commit/3f7e1d295d1ff9fac85d6a1fa87e56337e2fa607))

## [0.5.4](https://github.com/rambaarde/varve/compare/v0.5.3...v0.5.4) (2026-08-06)


### Bug Fixes

* **brief:** a one-line section is not a heading with nothing under it ([d585908](https://github.com/rambaarde/varve/commit/d585908cb05eabcd40747a4f9f8e943112a86903))
* **brief:** constraints survive the budget, and supersession actually runs ([71b6725](https://github.com/rambaarde/varve/commit/71b672571eb773996f8c3ef1d10b2581605c3ba3))
* **brief:** give constraints a floor, and shorten them before dropping any ([5dd6a30](https://github.com/rambaarde/varve/commit/5dd6a30a736a6b57a48658792ec7560f8eb73347))
* **publish:** make supersession a step that runs, not one to remember ([1a8790c](https://github.com/rambaarde/varve/commit/1a8790ce7a880a000c3129daa0a1fe4dd895dae4))

## [0.5.3](https://github.com/rambaarde/varve/compare/v0.5.2...v0.5.3) (2026-08-06)


### Bug Fixes

* **brief:** stop dropping old constraints on the floor ([bf03007](https://github.com/rambaarde/varve/commit/bf03007c71160b8bcd4db34bf542e604f99bed8f))
* **brief:** stop dropping old constraints on the floor ([fc5c152](https://github.com/rambaarde/varve/commit/fc5c152609a6a2425153c44d67bf72dff713735a))

## [0.5.2](https://github.com/rambaarde/varve/compare/v0.5.1...v0.5.2) (2026-08-06)


### Bug Fixes

* **onboarding:** a teammate needs no install, and n=2 no longer collides ([c869bb7](https://github.com/rambaarde/varve/commit/c869bb79ff3fe80d0693f2f2aa7f4d4334840190))
* **onboarding:** a teammate needs no install, and n=2 no longer collides ([1e81571](https://github.com/rambaarde/varve/commit/1e815714281e2ce325ee0dab124a7582ff9a1f51))

## [0.5.1](https://github.com/rambaarde/varve/compare/v0.5.0...v0.5.1) (2026-08-06)


### Bug Fixes

* **portability:** make it run on Windows, and test three Linux distros ([ddd095e](https://github.com/rambaarde/varve/commit/ddd095efd5fbd455e2661c26392ef4ce36c9be60))
* **portability:** run on Windows, and test three Linux distros ([32771f5](https://github.com/rambaarde/varve/commit/32771f5d20d6834bbe3168a391822c0a8a14aa31))
* **store:** treat backslash as a path separator in repoName ([8e04081](https://github.com/rambaarde/varve/commit/8e040811a2fbe9a95c78bad937c557b905ab2943))
* **test:** resolve temp dirs to their real path ([68624ac](https://github.com/rambaarde/varve/commit/68624acd9f788c37db0091e3510984bc8f9fdad5))
* **test:** stop the suite escaping its sandbox on Windows ([b625349](https://github.com/rambaarde/varve/commit/b62534961eea1f3f62dfca1cbae5698f48bcf206))

## [0.5.0](https://github.com/rambaarde/varve/compare/v0.4.0...v0.5.0) (2026-08-06)


### Features

* **integrations:** announce to a channel, link the issue tracker ([30a88d9](https://github.com/rambaarde/varve/commit/30a88d9b08a0d4dde38cfc2b424ba8bf162f180a))
* **integrations:** announce to a channel, link the issue tracker ([3970f70](https://github.com/rambaarde/varve/commit/3970f700343673414687c9a168776133d0e14071))

## [0.4.0](https://github.com/rambaarde/varve/compare/v0.3.0...v0.4.0) (2026-08-05)


### Features

* **agents:** install for every agent on the machine, and serve MCP ([38ec865](https://github.com/rambaarde/varve/commit/38ec8652ae9f52e05ec56aef67a368afe4d0ae0f))
* **agents:** install for every agent on the machine, and serve MCP ([8e7b017](https://github.com/rambaarde/varve/commit/8e7b0172c26ee2a3b8954b0bc55b5002b7e63ed7))
* **cli:** varve brief, and a note that tells any agent to run it ([c2e7229](https://github.com/rambaarde/varve/commit/c2e7229292792ba3dd4a77a8a40c1e3830debbc9))
* **cli:** varve brief, and a note that tells any agent to run it ([4594649](https://github.com/rambaarde/varve/commit/45946497c1c141ddfe8d37a372a0b46c9814ce96))

## [0.3.0](https://github.com/rambaarde/varve/compare/v0.2.16...v0.3.0) (2026-08-05)


### Features

* **portal:** redesign as a reference work, not a dashboard ([#71](https://github.com/rambaarde/varve/issues/71)) ([d3c3ba1](https://github.com/rambaarde/varve/commit/d3c3ba1c9c8e28a7cdf7fa20bcaf8cb13897e985))
* **portal:** redesign, command palette, and in-page project search ([0988f30](https://github.com/rambaarde/varve/commit/0988f3056a3b3aedefe64359c324eda7e6c9f784))

## [0.2.16](https://github.com/rambaarde/varve/compare/v0.2.15...v0.2.16) (2026-08-05)


### Bug Fixes

* **cli:** standing inside a memory is enough to find it ([81e568f](https://github.com/rambaarde/varve/commit/81e568f06a20b96c4e6597326e3b5869352e3d89))
* **cli:** standing inside a memory is enough to find it ([#68](https://github.com/rambaarde/varve/issues/68)) ([9185b4d](https://github.com/rambaarde/varve/commit/9185b4d38104351c78c462cdefa3f1c8c2a0c03a))

## [0.2.15](https://github.com/rambaarde/varve/compare/v0.2.14...v0.2.15) (2026-08-05)


### Bug Fixes

* **docs:** stop the install block being centred line by line ([78e175a](https://github.com/rambaarde/varve/commit/78e175a40e146820fa8257cc06e2a5ee07e6c821))
* **docs:** stop the install block being centred line by line ([#63](https://github.com/rambaarde/varve/issues/63)) ([df8bfd7](https://github.com/rambaarde/varve/commit/df8bfd7b879feea8d5697bf66414deed78dea8f5))

## [0.2.14](https://github.com/rambaarde/varve/compare/v0.2.13...v0.2.14) (2026-08-05)


### Bug Fixes

* **docs:** make the README test badge fail rather than drift ([59ae807](https://github.com/rambaarde/varve/commit/59ae807ebd8396b007034db63a757f2c9bd8d43a))
* **docs:** make the README test badge fail rather than drift ([#60](https://github.com/rambaarde/varve/issues/60)) ([71fa313](https://github.com/rambaarde/varve/commit/71fa3134024f78af678d623b9696147db22bac35))
