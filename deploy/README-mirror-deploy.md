# 国内镜像站部署指南 · Mirror hosting guide (Cloudflare Pages / Netlify)

**简体中文** | [English](#english-version)

GitHub Pages（`*.github.io`）在国内访问时通时不通，属于网络可达性问题，与代码无关。
本目录提供**一套零改动镜像方案**：同一份纯静态演示版，部署到国内可达性更好的静态托管平台，
得到形如 `https://campus-book-demo.pages.dev/web/` 的地址，任何电脑、手机浏览器打开即可使用。

---

## 一、镜像包结构

运行 `build-mirror.ps1`（或直接使用仓库中已生成好的 `deploy/dist`）得到：

```
deploy/dist/
├── index.html          落地页（介绍 + 「进入在线演示」按钮）
├── 404.html            SPA 兜底页（部分平台不支持 _redirects 时生效）
├── _redirects          SPA 回退规则：/web/* → /web/index.html 200（Cloudflare Pages / Netlify 通用）
├── _headers            缓存策略（长缓存 assets，不缓存 index.html）
├── .nojekyll           兼容 GitHub Pages 的忽略规则
└── web/                演示应用（Vue3 构建产物）
    ├── index.html
    ├── assets/         JS / CSS
    └── static/demo/    教材封面图（SVG）
```

> 演示应用固定挂在镜像站的 `/web/` 子路径下，与 GitHub Pages 上的地址结构完全一致，
> 因此页面内的路由、静态资源、分享链接（`/web/login?demo=13800000002`）全部原样可用。

---

## 二、方案 A：Cloudflare Pages 网页拖拽（推荐，最快）

1. 打开 <https://dash.cloudflare.com> 注册并登录（免费，无需信用卡，无需域名）。
2. 左侧选择 **Workers & Pages** → **Create** → 切到 **Pages** 标签 → **Upload assets**。
3. 项目名填 `campus-book-demo`（可自定义，将决定访问域名）→ **Create project**。
4. 把 `deploy/dist` **整个文件夹**拖进上传区（或点选择文件夹）→ **Deploy site**。
5. 等十几秒，得到访问地址：

   - 落地页： `https://campus-book-demo.pages.dev/`
   - 演示应用： `https://campus-book-demo.pages.dev/web/`

以后更新内容，进入该项目 → **Create new deployment** → 重新拖入 `deploy/dist` 即可，地址不变。

---

## 三、方案 B：命令行一键发布（适合反复更新）

前置：Node 20+（本仓库已满足），以及 Cloudflare 的 API Token。

1. 生成 Token：<https://dash.cloudflare.com/profile/api-tokens> → **Create Token** →
   自定义模板 → 权限选 `Account` : `Cloudflare Pages` : `Edit` → 创建并复制。
2. 找到 Account ID：控制台首页右侧栏，或地址栏 `dash.cloudflare.com/<32位串>`。
3. 在**仓库根目录**执行：

```powershell
# 先切到仓库根目录（按你的实际路径修改）
cd "C:\Users\Lenovo\Desktop\大学图书交易市场"

$env:CLOUDFLARE_API_TOKEN  = '<你的 Token>'
$env:CLOUDFLARE_ACCOUNT_ID = '<32 位 Account ID>'

.\deploy\deploy-cloudflare.ps1
```

脚本会自动重新构建前端 → 组装 `deploy/dist` → 发布到 Cloudflare Pages 项目 `campus-book-demo`。
首次运行 wrangler 会询问是否创建项目，输入 `y` 回车。想跳过重复构建加 `-SkipBuild`。

---

## 四、方案 C：Netlify（同样支持拖拽，`_redirects` 通用）

1. 打开 <https://app.netlify.com/drop>，登录后把 `deploy/dist` 拖进去。
2. 得到形如 `https://<随机名>.netlify.app/` 的地址，子路径结构与上面一致。
3. 建议在站点设置里把它改名成 `campus-book-demo`，避免随机后缀。

---

## 五、方案 D：腾讯云 EdgeOne Pages（国内节点）

需要腾讯云账号并完成实名认证，在 EdgeOne Pages 控制台新建项目、上传同一份 `deploy/dist`；
绑定已备案域名后国内访问最稳。适合后续正式上线，演示阶段方案 A 已足够。

---

## 六、按需修改子路径

若希望演示应用直接挂在根路径（`https://<域名>/`，不再有 `/web/`），执行：

```powershell
.\deploy\build-mirror.ps1 -Base '/'
```

随后把 `deploy/dist/web/index.html` 的内容覆盖为 `deploy/dist/index.html`（落地页与应用的取舍自行决定），
并相应调整 `_redirects` 为 `/*  /index.html  200`。默认建议保持 `/web/`，与文档、截图、分享链接一致。

---

## 七、常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 打开 `/web/books/1` 等深链接出现 404 | 平台未读取 `_redirects`。本项目已同时提供 `404.html` 兜底；若仍 404，检查 `_redirects` 是否被上传到发布根目录 |
| 页面白屏、控制台报 404 找不到 `/web/assets/...` | base 与实际子路径不一致，用 `build-mirror.ps1 -Base` 重建 |
| 封面图不显示 | 确认 `web/static/demo/*.svg` 已在发布目录中（本包已含 30 张） |
| 更新后仍看到旧页面 | `index.html` 已设为不缓存，强制刷新（Ctrl+F5）一次即可；`assets` 是带哈希的长缓存，无需处理 |
| 想换成自己的域名 | Cloudflare Pages 项目 → Custom domains → 添加域名并按提示在 DNS 加 CNAME；国内访问建议域名走 Cloudflare 代理 |
| 数据会不会和 GitHub Pages 那份串台 | 不会。演示数据存在各自浏览器 localStorage 中，两个地址互不影响，都是同一份初始种子数据 |

---

## 八、合规提示

演示版仅用于功能演示：**支付、短信、微信授权均为模拟实现**，请勿填入真实银行卡号、CVV、支付密码或真实学生证件。
正式上线需接入持牌支付/短信通道、完成 ICP 备案与实名认证，并遵循《个人信息保护法》最小必要原则存储脱敏数据。

---

<a id="english-version"></a>

# English version

`*.github.io` is intermittently unreachable from mainland China. That is a network reachability issue, not a code problem.
This directory ships a **zero-change mirror setup**: the same pure static demo, deployed to a static host with better reachability from mainland China,
giving you an address such as `https://campus-book-demo.pages.dev/web/` that opens on any computer or phone browser.

## 1. Bundle layout

Run `build-mirror.ps1` (or use the `deploy/dist` already generated in this repository) to produce:

```
deploy/dist/
├── index.html          Landing page (intro + "Enter live demo" button)
├── 404.html            SPA fallback (used when the host ignores _redirects)
├── _redirects          SPA fallback rule: /web/* → /web/index.html 200 (works on Cloudflare Pages / Netlify)
├── _headers            Cache policy (long cache for assets, no cache for index.html)
├── .nojekyll           Ignore rule for GitHub Pages compatibility
└── web/                Demo app (Vue 3 build output)
    ├── index.html
    ├── assets/         JS / CSS
    └── static/demo/    Textbook cover images (SVG)
```

> The demo app always lives under the `/web/` sub-path, exactly like on GitHub Pages, so in-app routes, static assets and share links
> (`/web/login?demo=13800000002`) all keep working unchanged.

## 2. Option A: Cloudflare Pages drag-and-drop (recommended, fastest)

1. Open <https://dash.cloudflare.com>, sign up and log in (free, no credit card, no domain needed).
2. Choose **Workers & Pages** → **Create** → switch to the **Pages** tab → **Upload assets**.
3. Name the project `campus-book-demo` (or anything you like; it determines the domain) → **Create project**.
4. Drag the whole `deploy/dist` folder into the upload area (or pick the folder) → **Deploy site**.
5. After a few seconds you get:

   - Landing page: `https://campus-book-demo.pages.dev/`
   - Demo app: `https://campus-book-demo.pages.dev/web/`

To update later, open the project → **Create new deployment** → drag `deploy/dist` again. The address stays the same.

## 3. Option B: one-command CLI publishing (good for repeated updates)

Prerequisites: Node 20+ (already satisfied by this repository) and a Cloudflare API token.

1. Create a token at <https://dash.cloudflare.com/profile/api-tokens> → **Create Token** →
   custom template → permission `Account` : `Cloudflare Pages` : `Edit` → create and copy it.
2. Find the Account ID: right-hand sidebar of the dashboard, or the 32-character string in the address bar.
3. From the **repository root**:

```powershell
# switch to your repository root first
cd "C:\Users\Lenovo\Desktop\University-Book-Trading-Market"

$env:CLOUDFLARE_API_TOKEN  = '<your token>'
$env:CLOUDFLARE_ACCOUNT_ID = '<32-character account id>'

.\deploy\deploy-cloudflare.ps1
```

The script rebuilds the front end → assembles `deploy/dist` → publishes to the Cloudflare Pages project `campus-book-demo`.
On the first run wrangler asks whether to create the project: type `y` and press Enter. Add `-SkipBuild` to skip the rebuild.

## 4. Option C: Netlify (also supports drag-and-drop; `_redirects` is identical)

1. Open <https://app.netlify.com/drop> and drag `deploy/dist` in after logging in.
2. You get an address like `https://<random>.netlify.app/` with the same sub-path structure.
3. Rename the site to `campus-book-demo` in the site settings to avoid the random suffix.

## 5. Option D: Tencent Cloud EdgeOne Pages (mainland nodes)

Requires a Tencent Cloud account with real-name verification; create a project in the EdgeOne Pages console and upload the same `deploy/dist`.
Reachability from mainland China is best once you bind a domain with an ICP filing. This suits a real launch; Option A is enough for demos.

## 6. Changing the sub-path

To serve the demo app at the root (`https://<domain>/` with no `/web/`):

```powershell
.\deploy\build-mirror.ps1 -Base '/'
```

Then decide whether the landing page or the app should own `deploy/dist/index.html`, and change `_redirects` to `/*  /index.html  200`.
Keeping `/web/` (the default) stays consistent with the docs, screenshots and share links.

## 7. FAQ

| Symptom | Cause and fix |
| --- | --- |
| 404 on deep links such as `/web/books/1` | The host does not read `_redirects`. This bundle also ships `404.html` as a fallback; if it still 404s, check that `_redirects` was uploaded to the publish root |
| Blank page, console 404s for `/web/assets/...` | The base does not match the actual sub-path; rebuild with `build-mirror.ps1 -Base` |
| Cover images missing | Make sure `web/static/demo/*.svg` is inside the publish folder (this bundle includes all 30) |
| Still seeing an old page after an update | `index.html` is set to no-cache; force refresh once (Ctrl+F5). Hashed `assets` are long-cached, which is fine |
| Want to use your own domain | Cloudflare Pages project → Custom domains → add the domain and follow the DNS CNAME instructions; proxying through Cloudflare improves mainland reachability |
| Will the data collide with the GitHub Pages copy? | No. Demo data lives in each browser's localStorage; the two addresses are independent and both start from the same seed data |

## 8. Compliance note

The demo is for functional demonstration only: **payments, SMS and WeChat authorization are all simulated**. Never enter real card numbers, CVV codes, payment passwords or real student ID images.
A real launch requires licensed payment and SMS channels, ICP filing and real-name verification, and must store masked data under the data-minimization principle of the Personal Information Protection Law.
