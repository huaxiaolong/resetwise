# Resetwise

Resetwise 帮你规划重置卡和续订时间，尽量多用额度。它支持周额度、可选的 5 小时窗口、公告重置和健康作息。[在线使用](https://codex-resetwise.vercel.app/)

## 本地运行

```sh
node server.mjs
```

打开 [http://127.0.0.1:3000/](http://127.0.0.1:3000/)。运行和测试无需安装额外依赖，已在 Node.js 24 上验证。

## 在 Codex 中使用 Skill

把 [Skill 目录](codex-plugin/skills/plan-codex-quota)的 GitHub 链接贴给 Codex，请它用 `$skill-installer` 安装。启动本地服务后，在 Codex 中运行 `$plan-codex-quota`。

Skill 从已登录的 Codex 读取可用额度和重置卡。订阅到期时间及缺失的卡片信息由用户补充。计算使用 0 天 iOS 宽限期，并提供文字方案和网页预填链接。

## 测试和部署

```sh
node --test
```

Vercel 使用 `vercel.json` 发布 `public/`，并通过 `api/plan.mjs` 运行规划器。多实例部署时，在服务端为各实例设置同一个随机的 `RESETWISE_PLAN_SECRET`，用于签名和验证方案令牌。

代码采用 [MIT 许可证](LICENSE)。
