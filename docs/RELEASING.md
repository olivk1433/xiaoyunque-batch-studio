# 发布流程

## 源码

使用全新仓库或经过检查的公开 Git 历史。发布前运行：

```sh
npm test
npm run audit:privacy
```

隐私检查扫描暂存区/已跟踪文件、作者邮箱和历史 blob，但它只是辅助检查，仍应人工审阅全部待发布文件。任何实际密钥、数据库、日志、报告或媒体均不可入库。

## Windows x64 便携包

1. 从 Node.js 官网下载与构建版本一致的 Windows x64 ZIP，校验 SHA-256 和数字签名，保留完整 LICENSE。
2. 构建脚本只接受指定目录中的 `node.exe` 和 LICENSE，不读取本机业务数据：

```powershell
node scripts/build-portable.mjs --runtime-dir '<官方Node解压目录>'
```

3. 包位于 `dist/xiaoyunque-batch-studio-v版本号-windows-x64`，每次构建不覆盖已有目录。核对 `manifest.json` 和空白 Key 文档。
4. 在另一份临时副本中运行，确认空项目、无 Key、默认并发 3、内置运行环境可用；不要启动最终发布目录，否则会生成个人数据目录。
5. 将整个便携目录压缩，保留顶层文件夹，生成 SHA-256 文件。压缩包不得包含 `.git`、`runtime`、`outputs`、`reports`、测试残留或真实 Key。

## GitHub Actions

- 普通 push/PR：Windows 和 Linux 上运行本地模拟测试与隐私检查，不注入生成服务 Key。
- 推送 `v*` 标签：Windows 任务校验版本号、运行检查、下载官方 Node.js、校验归档和签名、打包、生成校验文件并发布 GitHub Release。
- 工作流使用固定提交的官方 Actions。默认只读仓库权限，发布任务单独授予 contents:write。
- 标签发布使用 GitHub 自动提供的短期 GITHUB_TOKEN，不使用维护者的私人令牌。

发布版本必须如实说明：CI 使用模拟供应商，模型、额度与真实生成结果需使用者自行验证。
