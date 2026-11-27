# AGENTS.md

## 本仓库

cgscli 是我们发行的 omp:一个带补丁(`patches/`)和预装扩展(`plugin/omp-extension`、`packages/connect`)的 omp 构建,发布为 npm 包 `@cicori/cgs`。omp 固定在 `omp.lock.json` 里的提交。详见 `README.md`。

## 设计文档在别处

跨仓库设计文档单独放在 **`../cgs-client-docs`**(与本仓库同级目录)。涉及架构、协议、补丁、发布、更新的改动,动手前先读 `../cgs-client-docs/README.md` 与 `adr/`、`cgsconnect/patches.md`。代码与文档冲突时,先在文档里提出并解决,再改代码;新的架构决策在 `adr/` 新增 ADR,不改写已有 ADR,被取代的标注「被取代」。文档仓库只在本地提交,不推送(远端已归档)。

## 发布与版本号(硬性规则,见 ADR 0044)

- 版本号是 `<omp 版本>-cgs.<N>` 或 `<omp 版本>-cgs.<N>.<M>`。已发布 `19.2.1-cgs.5`,当前版本是 `19.2.1-cgs.5.2`。
- **修复和小改动发小版本 `N.M`**(`5.2` 之后是 `5.3`),不要为一个修复去升 `N`。
- **严禁自行提升大版本号 `N`**。`N` 只有所有者在对话里明确指示才能升;没有指示就不升,哪怕改动很大。
- **不推 tag、不发布,除非所有者明确同意。** npm 发布不可撤回,版本号错了只能往上走。
- 本机试装的包用将要发布的那个号,不要用更大的号(`cgs update` 按版本比较,更大的号会让正式版显得更旧)。
- 打包与冒烟:`bun scripts/pack-release.ts <N 或 N.M> --omp-dir <omp 构建目录> --out-dir <目录>`,再 `bun scripts/smoke-release.ts <tgz>`。CI 在 `v*` tag 上做同样的事再发布。

## 约定

- 补丁序列用 `git format-patch` 生成、`git am --3way` 回放;每个补丁的提交信息必须有 `Reason:`、`Upstream:`、`Remove-when:`(`scripts/replay-patches.ts` 会检查)。补丁文件数上限仍是 [未决 O4],不要自行决定。
- 面向用户的 `omp <命令>` 提示由 `scripts/brand-commands.ts` 改写;同步 omp 后出现新的提示时,在上游版本上重跑脚本,不手工合并。
- 本地检查:`bun test`(全部包、扩展与脚本)。
- 同一工作区里常有别人未提交的改动:只提交自己的改动,不要 `git add -A`、stash、reset。
