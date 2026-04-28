# 测试方法与流程

## 本地单测

- 修改代码后先跑 `pnpm test`。

## 远程实机验证

- 只能保留一个测试环境。
- 先确认没有其他 `wrangler dev --remote --port 8787` 在跑，再启动：

```bash
pnpx wrangler dev --remote --port 8787
```

- 测试日志建议放到 `logs/` 目录。
- `10808` 代理固定连当前测试环境的 `8787` 端口。
- 修改代码后通常会自动重载；如果日志没变化或行为没更新，先重启这一个测试环境，不要同时起多个。

## 代理复测

通过 `http://127.0.0.1:10808` 访问远程预览，至少复测这些场景：

```bash
curl -x http://127.0.0.1:10808 -k -I https://www.google.com
curl -x http://127.0.0.1:10808 -k -I https://www.cloudflare.com/cdn-cgi/trace
curl -x http://127.0.0.1:10808 -k -I -g https://[2001:4860:482d:7700::]/
curl -x http://127.0.0.1:10808 -I http://1.1.1.1
```

## 验收标准

- `pnpm test` 通过。
- IPv4 直连可用。
- IPv6 直连可用。
- NAT64 回退可用。
- 关键日志能看到 `Connecting to` / `Connected to` 的完整链路。
