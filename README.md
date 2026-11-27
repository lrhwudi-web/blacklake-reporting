# 黑湖生产报工系统

这个项目包含员工报工、组长派工、报表审批、黑湖同步队列，以及管理后台和生产看板。

| 目录 | 内容 |
| --- | --- |
| apps/api | Node.js 后端、SQLite、黑湖和微信接口 |
| apps/admin | 管理后台、报表和 3D 看板 |
| apps/miniprogram | 可在微信开发者工具中导入的小程序工程 |

## 本地启动

需 Node.js 22.9 或更新版本，建议使用 Node.js 24。

1. 将 .env.example 复制为 .env。保留 BLACKLAKE_MODE=mock，并为本地环境设置独立的 SESSION_SECRET 和 ADMIN_API_KEY。
2. 执行 npm ci 和 npm start。
3. 默认管理后台地址为 http://127.0.0.1:4180/admin 。
4. 在微信开发者工具中导入 apps/miniprogram。联调前在开发者工具中选择自己的 AppID 和联调后端，微信 AppSecret 由后端环境变量提供。

运行 npm run check 和 npm test 检查当前版本。

仓库包含可运行的空白人员规则配置。实际账号、生产数据库和企业专用的人员规则保存在部署环境。按自己的环境提供 BLACKLAKE 和 WECHAT 配置后，再进行正式接口联调。
