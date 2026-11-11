/* ================================================================
 * FDE 工作站 · 客户端面板（Harness Web UI 插件，无 JSX）
 *
 * 主面板：今日 / 客户 / 资料 / 流程 / 情报（5 页签 + 页头设置入口）
 * 结构分区：请求层 → 设计 token 与 CSS → 字典与工具 → 通用组件
 *           → 各视图 → 抽屉 → 宿主未就绪页/注册
 * v1.3：新增「流程」（8 阶段 playbook，spec §20.5）与「资料库」
 *       （策展资料 + GitHub 指标 + 社区动态，spec §19.6）；移除「生财」
 *       页签（宿主 scys 能力保留，社区内容并入资料库来源组）。
 *
 * 兼容：宿主未提供 GET /fde/meta（旧宿主未重启）时显示精简的
 *       「宿主未就绪」页（只给重试与重启说明），绝不白屏。
 * 事实来源：board 状态只在服务端 research/.fde/board.json；客户端
 *       每次写操作后重新拉取，不把本地 state 当事实源。
 * 主题：只用 --dsw-alias-* token（带浅色回退），明暗主题均可读。
 * 身份：包名 / client-modules 模块 id = dsh-fde（ADR 0004 D1）。
 * ================================================================ */
window.__ModuleLoader__.load({
  id: 'dsh-fde',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    /* ============================================================
     * 一、请求层
     * 统一前缀 /research-workbench/api；FDE 路由见 docs/01-spec.md §4。
     * 响应契约：成功 {ok:true,...}；失败 {ok:false, reason, code?}。
     * 不做客户端事实缓存：写操作后一律重新向服务端取 board。
     * ============================================================ */
    const API = '/research-workbench/api';
    const FDE = API + '/fde';
    const POLL_MS = 12000; /* 轮询 10–15s，spec §16.8 */
    const FETCH_TIMEOUT_MS = 8000; /* F-17：请求超时（8s），避免慢响应永久挂起轮询 */

    const errText = (e) => String((e && (e.message || e.code)) || e || '未知原因');

    /* 超时信号：优先 AbortSignal.timeout；不支持时用 AbortController + setTimeout 降级。 */
    function timeoutSignal(ms) {
      try {
        if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
      } catch (e) { /* ignore */ }
      try {
        if (typeof AbortController === 'function') {
          const ctl = new AbortController();
          const tid = setTimeout(() => { try { ctl.abort(); } catch (e) { /* ignore */ } }, ms);
          if (ctl.signal && typeof ctl.signal.addEventListener === 'function') {
            ctl.signal.addEventListener('abort', () => clearTimeout(tid), { once: true });
          }
          return ctl.signal;
        }
      } catch (e) { /* ignore */ }
      return undefined;
    }

    /* 在途 GET 去重：同一 path 未完成时不重复发（轮询 / 切页签 / 手动刷新可能重叠）。 */
    const inflightGets = new Map();
    function dedupeGet(url, run) {
      const key = String(url);
      if (inflightGets.has(key)) return inflightGets.get(key);
      const p = Promise.resolve().then(run).then(
        (v) => { inflightGets.delete(key); return v; },
        (e) => { inflightGets.delete(key); throw e; }
      );
      inflightGets.set(key, p);
      return p;
    }

    async function readJSON(res) {
      let text = '';
      try {
        text = await res.text();
      } catch (e) {
        return { ok: false, reason: '读取响应失败：' + errText(e) };
      }
      try {
        return JSON.parse(text);
      } catch (e) {
        const status = res && res.status;
        return {
          ok: false,
          httpStatus: status,
          reason: status === 404 ? 'HTTP 404（路由不存在，可能宿主未重启）'
            : '响应不是 JSON（HTTP ' + (status || '?') + '）：' + String(text).slice(0, 160),
        };
      }
    }

    async function getJSON(url) {
      return dedupeGet(url, async () => {
        try {
          const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: timeoutSignal(FETCH_TIMEOUT_MS) });
          return await readJSON(r);
        } catch (e) {
          const timedOut = !!(e && (e.name === 'TimeoutError' || e.name === 'AbortError'));
          return {
            ok: false,
            network: true,
            timeout: timedOut,
            reason: (timedOut ? '请求超时（' + Math.round(FETCH_TIMEOUT_MS / 1000) + 's）：' : '网络请求失败：') + errText(e),
          };
        }
      });
    }

    /* 资料预览读取：走宿主同源已鉴权路由 GET /api/file（文本 / PDF 字节 / 图片直链）。
       面板组件不直接 fetch；文件大小上限由宿主控制（默认 50MiB），这里只做超时与错误归一。 */
    async function readFileAbs(abs, as) {
      const url = '/api/file?path=' + encodeURIComponent(String(abs || ''));
      try {
        const r = await fetch(url, { credentials: 'same-origin', signal: timeoutSignal(30000) });
        if (!r || !r.ok) return { ok: false, reason: 'HTTP ' + ((r && r.status) || '?') };
        if (as === 'blob') return { ok: true, blob: await r.blob() };
        return { ok: true, text: await r.text() };
      } catch (e) {
        return { ok: false, reason: errText(e) };
      }
    }

    /* 实际发送函数；对外暴露的 postJSON 由 demoGuard 包裹（ADR 0006 D1：演示模式只读）。 */
    async function sendJSON(url, body, timeoutMs) {
      /* 写请求不做在途去重：同一 path 的两次提交可能语义不同（重复提交应被用户看到）。
         timeoutMs 可单次覆盖：upload / handoff / refresh 等天然慢于默认 8s 的写操作传更长的预算。 */
      const budget = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : FETCH_TIMEOUT_MS;
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {}),
          signal: timeoutSignal(budget),
        });
        return await readJSON(r);
      } catch (e) {
        const timedOut = !!(e && (e.name === 'TimeoutError' || e.name === 'AbortError'));
        return {
          ok: false,
          network: true,
          timeout: timedOut,
          reason: (timedOut ? '请求超时（' + Math.round(budget / 1000) + 's）：' : '网络请求失败：') + errText(e),
        };
      }
    }

    /* Phase 3（v1.5.0）只读演示模式：所有写请求统一走 demoGuard；
       第 4 参 { demoBypass: true } 仅供「清除/恢复示例」这类有意的设置写入使用。 */
    const postJSON = demoGuard(sendJSON);

    const fdeGet = (path) => getJSON(FDE + path);
    /* 慢路由按路径给预算：默认 8s；upload/扫描/PDF 生成/外部刷新这类天然更慢的写操作避免被误杀。
       调用点保持 fdePost(path, body) 原样（既有静态断言按该形式匹配）。 */
    const FDE_POST_BUDGETS = {
      '/upload': 180000,
      '/handoff': 60000,
      '/adopt': 60000,
      '/sync': 30000,
      '/library/refresh': 60000,
      '/scys/auth': 30000,
      '/bids/refresh': 30000,
    };
    const fdePost = (path, body, timeoutMs, opts) => postJSON(
      FDE + path, body, timeoutMs || FDE_POST_BUDGETS[path] || FETCH_TIMEOUT_MS, opts
    );

    /* ============================================================
     * 二、设计 token 与 CSS
     * 只引用 --dsw-alias-*（括号内为浅色主题回退值，不会覆盖主题）。
     * 版式：4/8 韵律；卡片 14px 内边距、12px 间距；按钮 32px。
     * ============================================================ */
    const CSS = `
/* ---- 主题别名：把宿主 token 收敛成一组语义变量，明暗自动切换 ---- */
.fde-root{
  --fde-bg:var(--dsw-alias-bg-base,transparent);
  --fde-surface:var(--dsw-alias-bg-layer-1,#fff);
  --fde-surface-2:var(--dsw-alias-bg-layer-2,#f5f6f7);
  --fde-surface-3:var(--dsw-alias-bg-layer-3,#ebeef2);
  --fde-border:var(--dsw-alias-border-l1,rgba(0,0,0,.08));
  --fde-border-2:var(--dsw-alias-border-l2,rgba(0,0,0,.14));
  --fde-text:var(--dsw-alias-label-primary,#1f2329);
  --fde-text-2:var(--dsw-alias-label-secondary,#646a73);
  --fde-text-3:var(--dsw-alias-label-tertiary,#8a9099);
  --fde-brand:var(--dsw-alias-brand-primary,#1f2329);
  --fde-on-brand:var(--dsw-alias-label-primary-inverted,#fff);
  --fde-accent:var(--dsw-alias-state-business-primary,#4d6bfe);
  --fde-danger:var(--dsw-alias-state-error-primary,#d92d20);
  --fde-warn:var(--dsw-alias-state-warn-primary,#e58b00);
  --fde-warn-text:var(--dsw-alias-state-warn-label,#b26a00);
  --fde-success:var(--dsw-alias-state-success-primary,#1a7f45);
  --fde-idle:var(--dsw-alias-state-idle-primary,#cfd3d6);
  --fde-hover:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));
  --fde-active:var(--dsw-alias-interactive-bg-active,rgba(0,0,0,.07));
  --fde-focus:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 32%,transparent);
  --fde-scroll:var(--dsw-alias-scrollbar-bg-l2,rgba(0,0,0,.12));
  --fde-scroll-hover:var(--dsw-alias-scrollbar-hover-l2,rgba(0,0,0,.24));
  display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;
  background:var(--fde-bg);color:var(--fde-text);
  font-size:var(--dsh-content-font-size,13px);line-height:1.6;
}
.fde-root *{box-sizing:border-box}
.fde-root button{font-family:inherit}
.fde-root :focus-visible{outline:none;box-shadow:var(--fde-focus)}
.fde-root ::-webkit-scrollbar{width:8px;height:8px}
.fde-root ::-webkit-scrollbar-thumb{background:var(--fde-scroll);border-radius:var(--dsw-radius-sm,8px)}
.fde-root ::-webkit-scrollbar-track{background:transparent}

/* ---- 顶部标题栏 ---- */
/* 窗口 chrome 避让（§2.9）：宿主用 CSS 变量下发顶栏 / 左侧占用，缺省 0 不影响普通页面 */
.fde-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;flex:0 0 auto;
  padding:calc(14px + var(--dsh-frame-top-clearance,0px)) 18px 10px calc(18px + var(--dsh-frame-leading-clearance,0px))}
.fde-top-left{display:flex;flex-direction:column;gap:2px;min-width:0}
.fde-title{font-size:20px;font-weight:650;letter-spacing:.2px;display:flex;align-items:center;gap:8px}
.fde-subtitle{font-size:12px;color:var(--fde-text-2)}
.fde-top-right{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.fde-autonomy{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;
  font-size:12px;border:0.5px solid var(--fde-border);background:var(--fde-surface-2);color:var(--fde-text-2);white-space:nowrap;corner-shape:round}
.fde-autonomy b{color:var(--fde-text);font-weight:650}
.fde-autonomy.observe{border-color:color-mix(in srgb,var(--fde-warn) 42%,transparent);background:color-mix(in srgb,var(--fde-warn) 12%,transparent);color:var(--fde-warn-text)}
.fde-autonomy.assisted{border-color:color-mix(in srgb,var(--fde-accent) 40%,transparent);background:color-mix(in srgb,var(--fde-accent) 10%,transparent);color:var(--fde-accent)}
.fde-autonomy.auto{border-color:color-mix(in srgb,var(--fde-danger) 40%,transparent);background:color-mix(in srgb,var(--fde-danger) 10%,transparent);color:var(--fde-danger)}

/* ---- 九视图导航（分段选择） ---- */
.fde-nav-wrap{padding:0 18px 10px;flex:0 0 auto}
/* Phase 2（layout.md §7）：页内子页签条 / 页头设置入口图标按钮 */
.fde-pagebar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:0 0 auto}
.fde-iconbtn{width:32px;height:32px;border:0.5px solid var(--fde-border);border-radius:var(--dsw-radius-md,12px);
  background:var(--fde-surface-2);color:var(--fde-text-2);font-size:16px;line-height:1;
  cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto}
.fde-iconbtn.on{border-color:color-mix(in srgb,var(--fde-accent) 46%,transparent);
  background:color-mix(in srgb,var(--fde-accent) 10%,transparent);color:var(--fde-accent)}
/* Phase 3（v1.5.0）演示模式：常驻横幅 + 空态三步引导 */
.fde-demo-banner{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 18px 10px;padding:8px 12px;
  border:1px solid color-mix(in srgb,var(--fde-accent) 40%,transparent);
  border-radius:var(--dsw-radius-md,12px);
  background:color-mix(in srgb,var(--fde-accent) 8%,transparent)}
.fde-demo-badge{display:inline-flex;align-items:center;padding:1px 8px;border-radius:var(--dsw-radius-sm,8px);
  corner-shape:round;background:color-mix(in srgb,var(--fde-accent) 16%,transparent);color:var(--fde-accent);
  font-size:11px;font-weight:600;white-space:nowrap}
.fde-demo-banner-text{color:var(--fde-text-2);font-size:12px}
.fde-onboard{display:flex;flex-direction:column;gap:6px;margin-top:8px;text-align:left}
.fde-onboard-step{display:flex;align-items:flex-start;gap:8px;font-size:12px;color:var(--fde-text-2)}
.fde-onboard-no{flex:0 0 auto;width:18px;height:18px;border-radius:var(--dsw-radius-sm,8px);corner-shape:round;
  background:var(--fde-surface-2);color:var(--fde-text-2);display:inline-flex;align-items:center;justify-content:center;font-size:11px}
.fde-nav{display:inline-flex;gap:2px;padding:3px;border-radius:var(--dsw-radius-md,12px);background:var(--fde-surface-2);border:0.5px solid var(--fde-border);max-width:100%;overflow-x:auto}
.fde-nav button{height:30px;padding:0 14px;border:1px solid transparent;border-radius:var(--dsw-radius-sm,8px);background:transparent;
  color:var(--fde-text-2);font-size:13px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:6px;transition:background .15s,color .15s}
.fde-nav button.on{background:var(--fde-surface);border-color:var(--fde-border);color:var(--fde-text);font-weight:600;box-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-label-primary,#000) 8%,transparent)}
.fde-nav .fde-cnt{min-width:18px;height:18px;padding:0 5px;border-radius:var(--dsw-radius-xs,4px);background:var(--fde-surface-3);
  color:var(--fde-text-2);font-size:11px;display:inline-flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums}
.fde-nav button.on .fde-cnt{background:color-mix(in srgb,var(--fde-accent) 16%,transparent);color:var(--fde-accent)}

/* ---- 主区域 ---- */
.fde-main{flex:1 1 auto;min-height:0;overflow:auto;padding:2px 18px 24px;display:flex;flex-direction:column;gap:12px}
.fde-view{display:flex;flex-direction:column;gap:12px;min-height:0}
.fde-view-fill{flex:1 1 auto;min-height:0}

/* ---- 通用：按钮 / 输入 / 芯片 / 卡片 ---- */
.fde-btn{height:32px;padding:0 14px;border-radius:var(--dsw-radius-md,12px);border:0.5px solid var(--fde-border);
  background:var(--fde-surface-2);color:var(--fde-text);font-size:13px;cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;transition:background .15s,border-color .15s}
.fde-btn.primary{background:var(--dsw-alias-button-primary-fill,var(--fde-brand));border-color:transparent;color:var(--fde-on-brand);font-weight:600}
.fde-btn.danger{color:var(--fde-danger);border-color:color-mix(in srgb,var(--fde-danger) 36%,transparent);
  background:color-mix(in srgb,var(--fde-danger) 8%,transparent)}
.fde-btn.ghost{background:transparent;border-color:transparent}
.fde-btn.small{height:26px;padding:0 10px;font-size:12px;border-radius:var(--dsw-radius-sm,8px)}
.fde-btn:disabled{opacity:.55;cursor:not-allowed;pointer-events:none}
.fde-btn.warn{color:var(--fde-warn-text);border-color:color-mix(in srgb,var(--fde-warn) 36%,transparent);background:color-mix(in srgb,var(--fde-warn) 8%,transparent)}
.fde-input,.fde-select,.fde-textarea{height:32px;padding:0 10px;border-radius:var(--dsw-radius-md,12px);border:0;box-shadow:var(--dsw-elevation-soft);
  background:var(--fde-surface-2);color:var(--fde-text);font-size:13px;font-family:inherit;min-width:0;transition:box-shadow .15s}
.fde-input::placeholder,.fde-textarea::placeholder{color:var(--fde-text-3)}
.fde-input:focus,.fde-select:focus,.fde-textarea:focus{outline:none;box-shadow:var(--fde-focus)}
.fde-textarea{height:auto;min-height:72px;padding:8px 10px;line-height:1.6;resize:vertical}
.fde-select{cursor:pointer}
.fde-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.fde-field>label,.fde-label{font-size:12px;color:var(--fde-text-2);letter-spacing:.2px}
.fde-form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}
.fde-full{grid-column:1/-1}
.fde-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.fde-row.tight{gap:6px}
.fde-spacer{flex:1 1 auto}
.fde-hint{font-size:12px;color:var(--fde-text-3);line-height:1.55}
.fde-note{font-size:12px;color:var(--fde-text-2);line-height:1.6}
.fde-chip{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 9px;border-radius:999px;font-size:12px;
  border:0.5px solid var(--fde-border);background:var(--fde-surface-2);color:var(--fde-text-2);white-space:nowrap;line-height:1;corner-shape:round}
.fde-chip.on,.fde-chip.accent{background:color-mix(in srgb,var(--fde-accent) 12%,transparent);
  border-color:color-mix(in srgb,var(--fde-accent) 40%,transparent);color:var(--fde-accent);font-weight:600}
.fde-chip.ok{background:color-mix(in srgb,var(--fde-success) 12%,transparent);border-color:color-mix(in srgb,var(--fde-success) 36%,transparent);color:var(--fde-success)}
.fde-chip.warn{background:color-mix(in srgb,var(--fde-warn) 14%,transparent);border-color:color-mix(in srgb,var(--fde-warn) 40%,transparent);color:var(--fde-warn-text)}
.fde-chip.danger{background:color-mix(in srgb,var(--fde-danger) 12%,transparent);border-color:color-mix(in srgb,var(--fde-danger) 36%,transparent);color:var(--fde-danger)}
.fde-chip.muted{background:transparent;color:var(--fde-text-3)}
.fde-chip .fde-num{font-variant-numeric:tabular-nums;font-weight:650}
.fde-card{background:var(--fde-surface);border:0.5px solid var(--fde-border);border-radius:var(--dsw-radius-xl,20px);padding:14px;min-width:0}
.fde-card.pad-sm{padding:10px 12px}
.fde-card-title{font-size:12px;font-weight:650;letter-spacing:1px;color:var(--fde-text-2);margin-bottom:10px;
  display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.fde-card-title .fde-spacer{flex:1}
.fde-section{display:flex;flex-direction:column;gap:8px;min-width:0}
.fde-section-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.fde-section-title{font-size:12px;font-weight:650;letter-spacing:1px;color:var(--fde-text-2)}
.fde-muted{color:var(--fde-text-2)}
.fde-warn{color:var(--fde-danger)} /* 逾期/警示文本：原代码在用、但此前没有样式（§2.3） */
.fde-dim{color:var(--fde-text-3)}
.fde-num{font-variant-numeric:tabular-nums;letter-spacing:.3px}
.fde-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--fde-text-2);word-break:break-all}

/* ---- 状态：加载 / 空 / 失败 / 行内提示 ---- */
.fde-loading{display:flex;align-items:center;gap:10px;padding:18px;color:var(--fde-text-2);font-size:13px}
.fde-spinner{width:16px;height:16px;border-radius:50%;border:2px solid var(--fde-border-2);
  border-top-color:var(--fde-accent);animation:fde-spin .8s linear infinite;flex:0 0 auto;corner-shape:round}
@keyframes fde-spin{to{transform:rotate(360deg)}}
.fde-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;
  padding:34px 16px;text-align:center;color:var(--fde-text-2);font-size:13px;min-height:120px}
.fde-empty .fde-empty-mark{width:34px;height:34px;border-radius:var(--dsw-radius-md,12px);border:1px dashed var(--fde-border-2);
  display:flex;align-items:center;justify-content:center;color:var(--fde-text-3);font-size:16px;margin-bottom:2px}
.fde-empty .fde-empty-title{font-size:13px;font-weight:600;color:var(--fde-text)}
.fde-error{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:var(--dsw-radius-md,12px);
  border:1px solid color-mix(in srgb,var(--fde-danger) 36%,transparent);
  background:color-mix(in srgb,var(--fde-danger) 8%,transparent);color:var(--fde-danger);font-size:13px;line-height:1.55}
.fde-error .fde-btn{flex:0 0 auto}
.fde-msg{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:var(--dsw-radius-md,12px);font-size:13px;
  border:0.5px solid var(--fde-border);background:var(--fde-surface-2);color:var(--fde-text)}
.fde-msg.ok{border-color:color-mix(in srgb,var(--fde-success) 36%,transparent);background:color-mix(in srgb,var(--fde-success) 8%,transparent);color:var(--fde-success)}
.fde-msg.warn{border-color:color-mix(in srgb,var(--fde-warn) 40%,transparent);background:color-mix(in srgb,var(--fde-warn) 10%,transparent);color:var(--fde-warn-text)}
.fde-msg.err{border-color:color-mix(in srgb,var(--fde-danger) 36%,transparent);background:color-mix(in srgb,var(--fde-danger) 8%,transparent);color:var(--fde-danger)}
.fde-msg .fde-spacer{flex:1}
.fde-live{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.fde-kbd{display:inline-flex;align-items:center;height:18px;padding:0 5px;border-radius:var(--dsw-radius-xs,4px);border:0.5px solid var(--fde-border-2);
  background:var(--fde-surface-2);color:var(--fde-text-3);font-size:11px;font-family:ui-monospace,Menlo,monospace}

/* ---- 今日：统计条 / 双栏 ---- */
.fde-stats{display:flex;flex-wrap:wrap;gap:8px}
.fde-stat{display:flex;flex-direction:column;gap:1px;min-width:92px;padding:10px 14px;border-radius:var(--dsw-radius-md,12px);
  background:var(--fde-surface);border:0.5px solid var(--fde-border)}
.fde-stat .fde-stat-num{font-size:20px;font-weight:650;letter-spacing:.5px;line-height:1.2;font-variant-numeric:tabular-nums}
.fde-stat .fde-stat-label{font-size:12px;color:var(--fde-text-2)}
.fde-stat.alert .fde-stat-num{color:var(--fde-danger)}
.fde-stat.warn .fde-stat-num{color:var(--fde-warn-text)}
.fde-stack{display:flex;flex-direction:column;gap:12px;min-width:0}

/* ---- 今日：一屏四宫格（ADR 0007 / spec §8.1） ---- */
/* 头部一行 KPI（约 52–60px 固定，不滚动）：左问候+战况，右 4 个内联指标 */
.fde-today{container-type:inline-size;gap:12px}
.fde-today-head{flex:0 0 auto;display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-height:52px;padding:2px 2px 0}
.fde-today-greet{flex:1 1 auto;min-width:0}
.fde-today-greet-title{font-size:16px;font-weight:650;line-height:1.35;color:var(--fde-text)}
.fde-today-greet-sub{font-size:12px;color:var(--fde-text-2);margin-top:2px;line-height:1.5;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.fde-today-kpis{flex:0 0 auto;display:flex;align-items:baseline;gap:20px;flex-wrap:wrap;margin-left:auto}
.fde-kpi{display:flex;flex-direction:column;line-height:1.15;min-width:0}
.fde-kpi-num{font-size:18px;font-weight:650;color:var(--fde-text);font-variant-numeric:tabular-nums}
.fde-kpi-num.warn{color:var(--fde-warn-text)}
.fde-kpi-num.alert{color:var(--fde-danger)}
.fde-kpi-label{font-size:11px;color:var(--fde-text-2);white-space:nowrap}
/* 四块同级：卡片 + 固定标题条 + 块内滚动 body；宽档页面级不滚动 */
.fde-today-grid{flex:1 1 auto;min-height:0;display:grid;gap:12px;
  grid-template-columns:repeat(4,minmax(0,1fr));grid-template-rows:minmax(0,1fr)}
.fde-today-panel{padding:0;display:flex;flex-direction:column;min-height:0;min-width:0;overflow:hidden}
.fde-today-panel-head{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:10px 12px 8px;
  border-bottom:0.5px solid var(--fde-border)}
.fde-today-panel-title{font-size:12px;font-weight:650;color:var(--fde-text-2);letter-spacing:.5px}
.fde-today-panel-count{font-size:11px;color:var(--fde-text-3);font-variant-numeric:tabular-nums}
.fde-today-panel-body{flex:1 1 auto;min-height:0;overflow:auto;padding:4px 10px 10px;overscroll-behavior:contain}
.fde-today-panel-body .fde-li{padding:8px 2px}
.fde-today-panel-body .fde-attn-group+.fde-attn-group{margin-top:6px;padding-top:4px}
.fde-today-panel-body .fde-empty{min-height:0;padding:16px 6px;gap:4px}
.fde-today-panel-body .fde-empty .fde-empty-mark{width:26px;height:26px;font-size:13px}
.fde-today-panel-body .fde-empty .fde-empty-title{font-size:12px}
.fde-today-panel-body .fde-empty .fde-row{flex-wrap:wrap;justify-content:center}
.fde-today-panel-body .fde-error{margin:6px 0}
.fde-today-panel-body .fde-loading{padding:14px 6px}
/* 中档（内容宽 900–1199）：2×2 等高，各自块内滚动 */
@container (max-width:1199px){
  .fde-today-grid{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr))}
}
/* 窄档（内容宽 <900）：单列、页面滚动，块内不再滚；顺序固定 待办→建议→焦点→活动 */
@container (max-width:899px){
  .fde-today-grid{display:flex;flex-direction:column;flex:0 0 auto;min-height:0}
  .fde-today-panel{min-height:180px}
  .fde-today-panel-body{overflow:visible;max-height:none}
  .fde-today-greet-sub{white-space:normal}
  .fde-today-kpis{margin-left:0;width:100%;gap:16px}
}

/* ---- 列表（注意力 / 建议 / 活动） ---- */
.fde-list{display:flex;flex-direction:column;min-width:0}
.fde-li{display:flex;align-items:flex-start;gap:10px;padding:10px 2px;border-bottom:1px dashed var(--fde-border);min-width:0}
.fde-li:last-child{border-bottom:0}
.fde-li-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px}
.fde-li-title{font-size:13px;font-weight:600;color:var(--fde-text);line-height:1.45;word-break:break-word}
.fde-li-title.clickable{cursor:pointer}
.fde-li-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--fde-text-2)}
.fde-li-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;flex:0 0 auto}
.fde-attn-kind{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:var(--dsw-radius-xs,4px);font-size:11px;
  font-weight:650;letter-spacing:.4px;border:1px solid transparent;flex:0 0 auto}
.fde-attn-blocked{background:color-mix(in srgb,var(--fde-danger) 14%,transparent);color:var(--fde-danger);border-color:color-mix(in srgb,var(--fde-danger) 32%,transparent)}
.fde-attn-decision{background:color-mix(in srgb,var(--fde-accent) 14%,transparent);color:var(--fde-accent);border-color:color-mix(in srgb,var(--fde-accent) 32%,transparent)}
.fde-attn-review{background:color-mix(in srgb,var(--fde-warn) 14%,transparent);color:var(--fde-warn-text);border-color:color-mix(in srgb,var(--fde-warn) 32%,transparent)}
.fde-attn-answer{background:color-mix(in srgb,var(--fde-accent) 12%,transparent);color:var(--fde-accent);border-color:color-mix(in srgb,var(--fde-accent) 28%,transparent)}
.fde-attn-overdue{background:color-mix(in srgb,var(--fde-danger) 10%,transparent);color:var(--fde-danger);border-color:color-mix(in srgb,var(--fde-danger) 26%,transparent)}
.fde-attn-gate{background:color-mix(in srgb,var(--fde-warn) 10%,transparent);color:var(--fde-warn-text);border-color:color-mix(in srgb,var(--fde-warn) 26%,transparent)}
.fde-attn-stall{background:var(--fde-surface-2);color:var(--fde-text-2);border-color:var(--fde-border)}
.fde-attn-proposal{background:color-mix(in srgb,var(--fde-accent) 10%,transparent);color:var(--fde-accent);border-color:color-mix(in srgb,var(--fde-accent) 26%,transparent)}
.fde-attn-default{background:var(--fde-surface-2);color:var(--fde-text-2);border-color:var(--fde-border)}

/* ---- 今日待处理：按 kind 分组折叠（§2.6）+ 行内「更多」菜单 ---- */
.fde-attn-group{display:flex;flex-direction:column;min-width:0}
.fde-attn-group+.fde-attn-group{margin-top:8px;padding-top:6px;border-top:1px dashed var(--fde-border)}
.fde-attn-group-head{display:flex;align-items:center;gap:8px;padding:0 2px 2px;min-width:0}
.fde-attn-group .fde-li{padding:8px 2px}
.fde-more{position:relative;flex:0 0 auto}
.fde-more-menu{position:absolute;right:0;top:calc(100% + 4px);z-index:8;min-width:124px;padding:4px;
  display:flex;flex-direction:column;gap:2px;background:var(--fde-surface);
  border-radius:var(--dsw-radius-md,12px);box-shadow:var(--dsw-elevation-prominent)}
.fde-more-item{height:28px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--fde-text);
  font:inherit;font-size:12px;text-align:left;cursor:pointer}


/* ---- 招采雷达（v1.1）：结果行 / 关系徽章 / 链接 / 未就绪提示 ---- */
.fde-bid-form{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
.fde-bid-form .fde-input:first-child{flex:1 1 220px;min-width:180px}
.fde-bid-form .fde-btn{flex:0 0 auto}
.fde-bid-list{display:flex;flex-direction:column;gap:6px;margin-top:6px}
.fde-bid-row{display:flex;gap:10px;align-items:flex-start;padding:9px 11px;border-radius:var(--dsw-radius-md,12px);
  background:var(--fde-surface-2);border:0.5px solid var(--fde-border);min-width:0}
.fde-bid-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px}
.fde-bid-title{display:flex;align-items:flex-start;gap:6px;font-size:13px;font-weight:600;line-height:1.45;min-width:0}
.fde-bid-title-text{min-width:0;word-break:break-word}
.fde-bid-meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px;color:var(--fde-text-2);min-width:0}
.fde-bid-kv{word-break:break-all}
.fde-bid-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;align-items:center;flex:0 0 auto}
.fde-bid-rel{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:var(--dsw-radius-xs,4px);font-size:11px;
  font-weight:650;letter-spacing:.4px;border:1px solid transparent;flex:0 0 auto}
.fde-bid-rel-winner,.fde-bid-rel-award{background:color-mix(in srgb,var(--fde-success) 14%,transparent);
  color:var(--fde-success);border-color:color-mix(in srgb,var(--fde-success) 32%,transparent)}
.fde-bid-rel-candidate{background:color-mix(in srgb,var(--fde-warn) 14%,transparent);
  color:var(--fde-warn-text);border-color:color-mix(in srgb,var(--fde-warn) 32%,transparent)}
.fde-bid-rel-buyer,.fde-bid-rel-tender{background:color-mix(in srgb,var(--fde-accent) 12%,transparent);
  color:var(--fde-accent);border-color:color-mix(in srgb,var(--fde-accent) 30%,transparent)}
.fde-bid-rel-mention,.fde-bid-rel-notice{background:var(--fde-surface-3);color:var(--fde-text-2);border-color:var(--fde-border)}
.fde-bid-expand{margin-top:2px;display:flex;flex-direction:column;gap:6px}
.fde-bid-excerpt{font-size:12px;line-height:1.65;color:var(--fde-text-2);white-space:pre-wrap;
  max-height:180px;overflow:auto;background:var(--fde-surface);border:0.5px solid var(--fde-border);
  border-radius:var(--dsw-radius-md,12px);padding:8px 10px;word-break:break-word}
.fde-bid-cands{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.fde-bid-subtitle{font-size:12px;font-weight:650;letter-spacing:.6px;color:var(--fde-text-2);margin:10px 0 2px}
.fde-bid-unavailable{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:var(--dsw-radius-md,12px);
  border:1px solid color-mix(in srgb,var(--fde-warn) 40%,transparent);
  background:color-mix(in srgb,var(--fde-warn) 10%,transparent);color:var(--fde-warn-text);
  font-size:13px;line-height:1.55}
.fde-bid-unavailable-mark{width:20px;height:20px;border-radius:50%;display:flex;align-items:center;
  justify-content:center;background:color-mix(in srgb,var(--fde-warn) 20%,transparent);
  font-weight:700;font-size:12px;flex:0 0 auto;corner-shape:round}
.fde-link{color:var(--fde-accent);text-decoration:none;font-size:12px;word-break:break-all}
.fde-link-btn{display:inline-flex;align-items:center;height:26px;padding:0 10px;border-radius:var(--dsw-radius-sm,8px);
  border:0.5px solid var(--fde-border);background:var(--fde-surface);font-size:12px;white-space:nowrap}
.fde-stat-num-sm{font-size:13px;font-weight:600;letter-spacing:0;line-height:1.4;word-break:break-word}

/* ---- 流程 v2（v1.3，spec §20.5）：阶段步进 / 详情 / 工具 chips / 矩阵 ---- */
.fde-flow{display:flex;gap:8px;overflow-x:auto;padding:4px 0 8px;align-items:stretch}
.fde-flow-step{flex:1 1 0;min-width:104px;display:flex;flex-direction:column;gap:3px;padding:9px 10px;
  border-radius:var(--dsw-radius-md,12px);border:0.5px solid var(--fde-border);background:var(--fde-surface-2);
  color:var(--fde-text);cursor:pointer;text-align:left;font:inherit;transition:border-color .15s,background .15s}
.fde-flow-step.on{background:var(--fde-surface);border-color:var(--fde-accent)}
.fde-flow-step-top{display:flex;align-items:center;gap:6px}
.fde-flow-num{font-size:11px;color:var(--fde-text-3);font-variant-numeric:tabular-nums}
.fde-flow-gate-dot{width:7px;height:7px;border-radius:50%;margin-left:auto;flex:0 0 auto;corner-shape:round}
.fde-flow-gate-dot.ok{background:var(--fde-success)}
.fde-flow-gate-dot.warn{background:var(--fde-warn)}
.fde-flow-name{font-size:13px;font-weight:650;line-height:1.3}
.fde-flow-count{font-size:11px;color:var(--fde-text-3);white-space:nowrap}
.fde-flow-detail{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
.fde-flow-block{display:flex;flex-direction:column;gap:6px;min-width:0;padding:10px 12px;
  border-radius:var(--dsw-radius-md,12px);background:var(--fde-surface-2);border:0.5px solid var(--fde-border)}
.fde-flow-wide{grid-column:1/-1}
.fde-flow-block-title{font-size:12px;font-weight:650;letter-spacing:.8px;color:var(--fde-text-2)}
.fde-flow-sub{font-size:12px;font-weight:600;color:var(--fde-text-2);margin-bottom:4px}
.fde-flow-goal{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding:10px 12px;border-radius:var(--dsw-radius-md,12px);
  background:color-mix(in srgb,var(--fde-accent) 7%,transparent);
  border:1px solid color-mix(in srgb,var(--fde-accent) 24%,transparent);font-size:13px;line-height:1.6}
.fde-flow-goal-label{flex:0 0 auto;font-size:11px;font-weight:650;letter-spacing:.8px;color:var(--fde-accent)}
.fde-flow-list{margin:0;padding-left:16px;display:flex;flex-direction:column;gap:4px;font-size:12px;
  line-height:1.55;color:var(--fde-text-2);word-break:break-word}
.fde-flow-tools{display:flex;flex-direction:column;gap:8px}
.fde-flow-tool-group{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap}
.fde-flow-tool-kind{flex:0 0 44px;font-size:11px;font-weight:650;color:var(--fde-text-3);letter-spacing:.6px;line-height:24px}
.fde-flow-tool-item{display:flex;flex-direction:column;gap:6px;min-width:0}
.fde-flow-tool{height:24px;padding:0 10px;border-radius:var(--dsw-radius-sm,8px);border:0.5px solid var(--fde-border);
  background:var(--fde-surface);color:var(--fde-text);font-size:12px;cursor:pointer;text-align:left}
.fde-flow-tool.on{border-color:color-mix(in srgb,var(--fde-accent) 46%,transparent);
  background:color-mix(in srgb,var(--fde-accent) 10%,transparent);color:var(--fde-accent);font-weight:600}
.fde-flow-example{display:flex;flex-direction:column;gap:5px;padding:8px 10px;border-radius:var(--dsw-radius-md,12px);
  background:var(--fde-surface);border:1px dashed var(--fde-border-2);max-width:560px}
.fde-flow-example-label{font-size:11px;font-weight:650;letter-spacing:.6px;color:var(--fde-accent)}
.fde-flow-example-text{font-size:12px;line-height:1.6;color:var(--fde-text-2);word-break:break-word}
.fde-flow-gate-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
.fde-matrix-wrap{overflow:auto;max-height:56vh;border:0.5px solid var(--fde-border);border-radius:var(--dsw-radius-md,12px)}
.fde-matrix{border-collapse:collapse;font-size:12px;min-width:100%}
.fde-matrix th,.fde-matrix td{border-bottom:0.5px solid var(--fde-border);padding:6px 9px;
  text-align:left;white-space:nowrap;color:var(--fde-text-2)}
.fde-matrix thead th{position:sticky;top:0;z-index:1;background:var(--fde-surface);
  color:var(--fde-text-2);font-weight:650}
.fde-matrix tbody th{position:sticky;left:0;z-index:1;background:var(--fde-surface);
  color:var(--fde-text);font-weight:600;border-right:0.5px solid var(--fde-border)}
.fde-matrix td.on{color:var(--fde-success);font-weight:700;text-align:center}
@media (max-width:720px){.fde-flow-step{min-width:92px}}

/* ---- 资料库（v1.3，spec §19.6）：信息条 / 重点推荐 / 筛选 / 卡片网格 ---- */
.fde-lib-info{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:var(--dsw-radius-md,12px);
  background:var(--fde-surface-2);border:0.5px solid var(--fde-border);min-width:0}
.fde-lib-info .fde-chip{background:var(--fde-surface);border-color:var(--fde-border)}
.fde-lib-groups{max-width:100%;overflow-x:auto}
.fde-lib-featured{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px;margin-top:4px}
.fde-lib-featured-card{display:flex;flex-direction:column;gap:6px;padding:12px;border-radius:var(--dsw-radius-xl,20px);min-width:0;
  background:color-mix(in srgb,var(--fde-accent) 6%,transparent);
  border:1px solid color-mix(in srgb,var(--fde-accent) 26%,transparent)}
.fde-lib-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px;margin-top:8px}
.fde-lib-card{display:flex;flex-direction:column;gap:7px;padding:12px;border-radius:var(--dsw-radius-xl,20px);min-width:0;
  background:var(--fde-surface-2);border:0.5px solid var(--fde-border);transition:border-color .15s}
.fde-lib-badges{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-height:20px}
.fde-lib-group{font-size:11px;font-weight:600;letter-spacing:.3px;color:var(--fde-text-3);white-space:nowrap}
.fde-lib-kind{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:var(--dsw-radius-xs,4px);white-space:nowrap;
  font-size:11px;font-weight:650;letter-spacing:.4px;border:1px solid transparent;
  background:var(--fde-surface-3);color:var(--fde-text-2)}
.fde-lib-auth{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;
  padding:0 5px;border-radius:var(--dsw-radius-xs,4px);font-size:11px;font-weight:700;border:1px solid transparent}
.fde-lib-auth-a{background:color-mix(in srgb,var(--fde-success) 13%,transparent);color:var(--fde-success);
  border-color:color-mix(in srgb,var(--fde-success) 32%,transparent)}
.fde-lib-auth-b{background:color-mix(in srgb,var(--fde-accent) 12%,transparent);color:var(--fde-accent);
  border-color:color-mix(in srgb,var(--fde-accent) 30%,transparent)}
.fde-lib-auth-c{background:var(--fde-surface-3);color:var(--fde-text-2);border-color:var(--fde-border)}
.fde-lib-title{display:block;width:100%;padding:0;border:0;background:transparent;color:var(--fde-text);
  font:inherit;font-size:13px;font-weight:650;line-height:1.45;text-align:left;word-break:break-word;cursor:pointer}
.fde-lib-title-plain{cursor:default;color:var(--fde-text)}
.fde-lib-byline{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--fde-text-3)}
.fde-lib-summary{font-size:12px;line-height:1.65;color:var(--fde-text-2);white-space:pre-wrap;word-break:break-word;
  display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;line-clamp:3;overflow:hidden}
.fde-lib-why{font-size:12px;line-height:1.6;color:var(--fde-text-2);
  display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;overflow:hidden}
.fde-lib-repo{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--fde-text-3)}
.fde-lib-stages{display:flex;flex-wrap:wrap;gap:5px}
.fde-lib-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:2px}
@media (max-width:720px){.fde-lib-grid{grid-template-columns:1fr}.fde-lib-featured{grid-template-columns:1fr}}

/* ---- 看板 ---- */
.fde-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:0 0 auto}
.fde-seg{display:inline-flex;gap:2px;padding:3px;border-radius:var(--dsw-radius-md,12px);background:var(--fde-surface-2);border:0.5px solid var(--fde-border)}
.fde-seg button{height:26px;padding:0 12px;border-radius:var(--dsw-radius-sm,8px);border:1px solid transparent;background:transparent;
  color:var(--fde-text-2);font-size:12px;cursor:pointer;white-space:nowrap}
.fde-seg button.on{background:var(--fde-surface);border-color:var(--fde-border);color:var(--fde-text);font-weight:600}
.fde-search{position:relative;display:flex;align-items:center;flex:0 1 240px;min-width:150px}
.fde-search .fde-input{width:100%;padding-left:28px;height:30px;font-size:13px}
.fde-search .fde-search-icon{position:absolute;left:9px;top:50%;transform:translateY(-50%);color:var(--fde-text-3);font-size:12px;pointer-events:none}
.fde-board{display:flex;gap:10px;align-items:flex-start;overflow-x:auto;padding:2px 2px 12px;min-height:0;flex:1 1 auto}
/* 看板横滚示能（§2.7）：外层容器 + 溢出提示 + 右侧渐隐（滚到末尾时取消遮罩） */
.fde-board-wrap{position:relative;display:flex;flex-direction:column;flex:1 1 auto;min-height:0}
.fde-board-hint{display:flex;align-items:center;gap:6px;padding:0 2px 6px;font-size:12px;color:var(--fde-text-3)}
.fde-board.mask-right{-webkit-mask-image:linear-gradient(90deg,var(--fde-text) calc(100% - 32px),transparent);
  mask-image:linear-gradient(90deg,var(--fde-text) calc(100% - 32px),transparent)}
/* 列宽自适应（§2.7）：先不改 8 列结构；窄屏收窄、宽屏最多 258px */
.fde-col{flex:1 1 clamp(180px,17vw,258px);min-width:180px;display:flex;flex-direction:column;gap:8px;min-height:120px;
  border-radius:var(--dsw-radius-lg,16px);padding:8px;border:1px solid transparent;transition:background .15s,border-color .15s}
.fde-col.over{background:color-mix(in srgb,var(--fde-accent) 7%,transparent);border-color:color-mix(in srgb,var(--fde-accent) 34%,transparent)}
.fde-col-head{display:flex;align-items:center;gap:6px;padding:2px 4px;min-height:26px}
.fde-col-title{font-size:12px;font-weight:650;letter-spacing:.4px;color:var(--fde-text-2)}
.fde-col-count{font-size:11px;color:var(--fde-text-3);font-variant-numeric:tabular-nums}
.fde-col-wip{font-size:11px;color:var(--fde-warn-text);font-variant-numeric:tabular-nums}
.fde-col.over-wip .fde-col-wip{color:var(--fde-danger)}
.fde-col-body{display:flex;flex-direction:column;gap:8px;min-height:60px}
.fde-col-empty{font-size:12px;color:var(--fde-text-3);text-align:center;padding:14px 4px;border:1px dashed var(--fde-border);border-radius:var(--dsw-radius-md,12px)}
.fde-card.draggable{cursor:grab;transition:border-color .15s,box-shadow .15s,opacity .15s}
.fde-card.dragging{opacity:.45;cursor:grabbing}
.fde-card.paused{opacity:.72}
.fde-card-title-row{display:flex;align-items:flex-start;gap:6px;min-width:0}
.fde-card-name{font-size:13px;font-weight:650;line-height:1.4;flex:1 1 auto;min-width:0;word-break:break-word}
.fde-card-days{font-size:11px;color:var(--fde-text-3);font-variant-numeric:tabular-nums;flex:0 0 auto}
.fde-card-next{margin-top:6px;font-size:12px;color:var(--fde-text-2);line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.fde-card-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px}
.fde-card-tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:6px}
.fde-dot{width:7px;height:7px;border-radius:50%;background:var(--fde-idle);flex:0 0 auto;display:inline-block;corner-shape:round}
.fde-dot.high{background:var(--fde-danger)}
.fde-dot.normal{background:var(--fde-accent)}
.fde-dot.low{background:var(--fde-idle)}
.fde-dot.ok{background:var(--fde-success)}
.fde-dot.warn{background:var(--fde-warn)}
.fde-dot.alert{background:var(--fde-danger)}
.fde-dotline{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--fde-text-3);font-variant-numeric:tabular-nums}

/* ---- 表格 ---- */
.fde-table-wrap{background:var(--fde-surface);border:0.5px solid var(--fde-border);border-radius:var(--dsw-radius-xl,20px);overflow:hidden}
.fde-table{width:100%;border-collapse:collapse;font-size:13px}
.fde-table th{text-align:left;font-size:11px;font-weight:650;letter-spacing:.6px;color:var(--fde-text-2);
  padding:9px 12px;border-bottom:0.5px solid var(--fde-border);background:var(--fde-surface-2);white-space:nowrap}
.fde-table td{padding:10px 12px;border-bottom:0.5px solid var(--fde-border);vertical-align:top;color:var(--fde-text)}
.fde-table tr:last-child td{border-bottom:0}
.fde-table tbody tr{cursor:pointer;transition:background .12s}
.fde-table .fde-cell-name{font-weight:600;min-width:160px}
.fde-table .fde-cell-now{max-width:300px;color:var(--fde-text-2)}
.fde-table .fde-cell-num{font-variant-numeric:tabular-nums;white-space:nowrap}
.fde-table .fde-cell-actions{text-align:right;white-space:nowrap}
.fde-table tbody tr.archived td{opacity:.6}
.fde-prio{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--fde-text-2)}
.fde-attn-cell{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--fde-danger)}
.fde-attn-cell.quiet{color:var(--fde-text-3)}

/* ---- 导入（adopt 两段式） ---- */
.fde-adopt{display:flex;flex-direction:column;gap:10px}
.fde-cand{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:var(--dsw-radius-md,12px);
  background:var(--fde-surface-2);border:0.5px solid var(--fde-border)}
.fde-cand .fde-cand-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px}
.fde-cand-title{font-weight:600;font-size:13px}
.fde-cand input[type="checkbox"]{margin-top:2px;accent-color:var(--fde-accent);width:15px;height:15px;flex:0 0 auto}
.fde-check{display:flex;align-items:flex-start;gap:8px;font-size:13px;color:var(--fde-text);cursor:pointer}
.fde-check input[type="checkbox"]{margin-top:3px;accent-color:var(--fde-accent);width:14px;height:14px;flex:0 0 auto}

/* ---- 工件 ---- */
.fde-files{display:flex;flex-direction:column;gap:6px}
.fde-file{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 10px;border-radius:var(--dsw-radius-sm,8px);background:var(--fde-surface-2);min-width:0}
.fde-file .fde-file-rel{flex:1 1 220px;min-width:0;font-size:12px;color:var(--fde-text);word-break:break-all;font-family:ui-monospace,Menlo,monospace}
.fde-file .fde-file-meta{font-size:11px;color:var(--fde-text-3);font-variant-numeric:tabular-nums;white-space:nowrap}
.fde-file-actions{display:flex;gap:4px;flex-wrap:wrap}
.fde-group{display:flex;flex-direction:column;gap:6px;margin-top:10px}
.fde-group-title{font-size:12px;font-weight:650;color:var(--fde-text-2);letter-spacing:.6px;display:flex;align-items:center;gap:8px}
.fde-drop{margin:2px 0;padding:16px;border:1px dashed var(--fde-border-2);border-radius:var(--dsw-radius-md,12px);
  background:var(--fde-surface-2);cursor:pointer;text-align:center;transition:border-color .15s,background .15s}
.fde-drop.on{border-color:var(--fde-accent);background:color-mix(in srgb,var(--fde-accent) 8%,transparent)}
.fde-loc{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:7px 10px;border-radius:var(--dsw-radius-sm,8px);background:var(--fde-surface-2);margin-bottom:8px}
.fde-loc .fde-code{flex:1 1 240px}
.fde-acc{display:flex;flex-direction:column;gap:8px}
.fde-acc-item{border:0.5px solid var(--fde-border);border-radius:var(--dsw-radius-md,12px);background:var(--fde-surface);overflow:hidden}
.fde-acc-head{display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:pointer;background:transparent;border:0;width:100%;text-align:left;color:inherit;font-size:13px}
/* 手风琴头改为 div[role=button]（§2.4）：Finder 按钮移到头外，避免 button 嵌套 button */
.fde-acc-row{display:flex;align-items:center;gap:4px;padding-right:8px}
.fde-acc-row .fde-acc-head{flex:1 1 auto;width:auto}
.fde-acc-tools{flex:0 0 auto;display:flex;align-items:center;gap:4px}
.fde-acc-body{padding:4px 12px 12px;border-top:1px dashed var(--fde-border)}
.fde-caret{display:inline-block;width:12px;color:var(--fde-text-3);transition:transform .15s}
.fde-caret.open{transform:rotate(90deg)}

/* ---- 方法 ---- */
.fde-mth{display:flex;flex-wrap:wrap;gap:6px}
.fde-mth button{font-size:12px;padding:6px 10px;border-radius:var(--dsw-radius-sm,8px);background:var(--fde-surface-2);
  border:0.5px solid var(--fde-border);color:var(--fde-text);cursor:pointer;text-align:left}
.fde-pre{white-space:pre-wrap;font-size:12px;line-height:1.75;max-height:58vh;overflow:auto;
  background:var(--fde-surface-2);border:0.5px solid var(--fde-border);border-radius:var(--dsw-radius-md,12px);padding:14px;margin:0;color:var(--fde-text)}
.fde-skill{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:var(--dsw-radius-sm,8px);background:var(--fde-surface-2);border:0.5px solid var(--fde-border)}
.fde-skill-name{font-size:12px;font-weight:650;font-family:ui-monospace,Menlo,monospace;color:var(--fde-text)}
.fde-skill-desc{font-size:12px;color:var(--fde-text-2);line-height:1.55}

/* ---- 设置 ---- */
.fde-set-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 0;border-bottom:1px dashed var(--fde-border)}
.fde-set-row:last-child{border-bottom:0}
.fde-set-main{flex:1 1 280px;min-width:0;display:flex;flex-direction:column;gap:2px}
.fde-set-name{font-size:13px;font-weight:600}
.fde-set-desc{font-size:12px;color:var(--fde-text-2);line-height:1.55}
.fde-set-ctl{flex:0 0 auto;display:flex;align-items:center;gap:8px}
.fde-health{display:flex;flex-direction:column;gap:6px}
.fde-health-item{display:flex;align-items:flex-start;gap:8px;font-size:12px;padding:6px 0;border-bottom:1px dashed var(--fde-border)}
.fde-health-item:last-child{border-bottom:0}
.fde-health-name{font-weight:600;min-width:110px;flex:0 0 auto}
.fde-health-detail{color:var(--fde-text-2);word-break:break-word}
.fde-redline{margin:8px 0 0;padding-left:18px;font-size:12px;color:var(--fde-text-2);line-height:1.7}
.fde-redline li::marker{color:var(--fde-danger)}

/* ---- 抽屉 ---- */
.fde-mask{position:fixed;inset:0;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.28));z-index:60;
  display:flex;justify-content:flex-end;animation:fde-fade .16s ease-out}
@keyframes fde-fade{from{opacity:0}to{opacity:1}}
.fde-drawer{width:min(560px,94vw);height:100%;background:var(--fde-surface);
  display:flex;flex-direction:column;box-shadow:var(--dsw-elevation-panel);animation:fde-slide .18s ease-out;min-height:0}
@keyframes fde-slide{from{transform:translateX(24px);opacity:.4}to{transform:translateX(0);opacity:1}}
.fde-drawer-head{display:flex;align-items:flex-start;gap:10px;padding:14px 16px 10px;border-bottom:0.5px solid var(--fde-border);flex:0 0 auto}
.fde-drawer-head-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px}
.fde-drawer-title{font-size:16px;font-weight:650;line-height:1.35;word-break:break-word;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.fde-drawer-sub{font-size:12px;color:var(--fde-text-2);display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.fde-drawer-close{width:28px;height:28px;border-radius:var(--dsw-radius-sm,8px);border:1px solid transparent;background:transparent;
  color:var(--fde-text-2);font-size:16px;line-height:1;cursor:pointer;flex:0 0 auto}
.fde-drawer-body{flex:1 1 auto;min-height:0;overflow:auto;padding:14px 16px 18px;display:flex;flex-direction:column;gap:14px}
.fde-drawer-foot{flex:0 0 auto;display:flex;gap:8px;flex-wrap:wrap;padding:12px 16px;border-top:0.5px solid var(--fde-border);background:var(--fde-surface)}
.fde-drawer-foot .fde-spacer{flex:1}
.fde-block{display:flex;flex-direction:column;gap:8px;min-width:0}
.fde-block-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.fde-block-title{font-size:12px;font-weight:650;letter-spacing:.8px;color:var(--fde-text-2)}

/* ---- 阶段步进条 ---- */
.fde-stepper{display:flex;align-items:stretch;gap:4px;flex-wrap:wrap}
.fde-step{flex:1 1 60px;min-width:58px;display:flex;flex-direction:column;align-items:center;gap:4px;
  padding:7px 4px;border-radius:var(--dsw-radius-md,12px);border:0.5px solid var(--fde-border);background:var(--fde-surface-2);
  color:var(--fde-text-2);font-size:11px;cursor:pointer;position:relative;transition:border-color .15s,background .15s}
.fde-step .fde-step-num{width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  font-size:11px;background:var(--fde-surface-3);color:var(--fde-text-2);font-variant-numeric:tabular-nums;corner-shape:round}
.fde-step.on{border-color:var(--fde-accent);background:color-mix(in srgb,var(--fde-accent) 10%,transparent);color:var(--fde-accent);font-weight:650}
.fde-step.on .fde-step-num{background:var(--fde-accent);color:var(--fde-on-brand);font-weight:700}
.fde-step.done .fde-step-num{background:color-mix(in srgb,var(--fde-success) 18%,transparent);color:var(--fde-success)}
.fde-step.paused{opacity:.65}

/* ---- 门禁清单 ---- */
.fde-gate-list{display:flex;flex-direction:column;gap:8px}
.fde-gate-item{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:var(--dsw-radius-md,12px);background:var(--fde-surface-2);border:0.5px solid var(--fde-border)}
.fde-gate-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px}
.fde-gate-line .fde-gate-key{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--fde-text-3)}
.fde-gate-auto{display:flex;flex-wrap:wrap;gap:6px}
.fde-gate-item.missing{border-color:color-mix(in srgb,var(--fde-danger) 30%,transparent);background:color-mix(in srgb,var(--fde-danger) 5%,transparent)}
.fde-gate-item.pass{border-color:color-mix(in srgb,var(--fde-success) 28%,transparent)}
.fde-gate-evidence{height:28px;font-size:12px}

/* ---- 时间线 / 回报 ---- */
.fde-timeline{display:flex;flex-direction:column;gap:2px}
.fde-tl-item{display:flex;gap:10px;padding:6px 0;min-width:0}
.fde-tl-rail{display:flex;flex-direction:column;align-items:center;flex:0 0 10px;padding-top:4px}
.fde-tl-dot{width:7px;height:7px;border-radius:50%;background:var(--fde-border-2);flex:0 0 auto;corner-shape:round}
.fde-tl-dot.human{background:var(--fde-accent)}
.fde-tl-dot.agent{background:var(--fde-success)}
.fde-tl-dot.system{background:var(--fde-idle)}
.fde-tl-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}
.fde-tl-text{font-size:12px;color:var(--fde-text);line-height:1.5;word-break:break-word}
.fde-tl-time{font-size:11px;color:var(--fde-text-3);font-variant-numeric:tabular-nums}
.fde-report{display:flex;flex-direction:column;gap:3px;padding:9px 12px;border-radius:var(--dsw-radius-sm,8px);background:var(--fde-surface-2);border:0.5px solid var(--fde-border)}
.fde-report .fde-report-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--fde-text-2)}
.fde-report .fde-report-text{font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.fde-kv{display:grid;grid-template-columns:84px minmax(0,1fr);gap:6px 10px;font-size:12px;align-items:center}
.fde-kv .fde-kv-k{color:var(--fde-text-2);font-size:12px}
.fde-kv .fde-kv-v{min-width:0;word-break:break-word}

/* ---- 弹层（确认 / 强制 / 证据） ---- */
.fde-modal-mask{position:fixed;inset:0;z-index:80;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.32));
  display:flex;align-items:center;justify-content:center;padding:20px;animation:fde-fade .14s ease-out}
.fde-modal{width:min(480px,94vw);max-height:86vh;overflow:auto;background:var(--fde-surface);
  border-radius:var(--dsw-radius-panel,28px);box-shadow:var(--dsw-elevation-prominent);display:flex;flex-direction:column}
.fde-modal-head{display:flex;align-items:center;gap:8px;padding:14px 16px 8px}
.fde-modal-title{font-size:14px;font-weight:650;flex:1 1 auto;min-width:0}
.fde-modal-title.danger{color:var(--fde-danger)}
.fde-modal-body{padding:4px 16px 12px;display:flex;flex-direction:column;gap:10px;font-size:13px;line-height:1.6;color:var(--fde-text)}
.fde-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:10px 16px 14px;flex-wrap:wrap}
.fde-missing{display:flex;flex-direction:column;gap:4px;margin:0;padding-left:18px;font-size:12px;color:var(--fde-danger)}
.fde-missing li{line-height:1.55}

/* ---- 宿主未就绪页 ---- */
.fde-compat{display:flex;align-items:center;justify-content:center;flex:1 1 auto;padding:24px}
.fde-compat-card{max-width:620px;width:100%;display:flex;flex-direction:column;gap:12px;padding:22px;
  background:var(--fde-surface);border:0.5px solid var(--fde-border);border-radius:var(--dsw-radius-xl,20px)}
.fde-compat-title{font-size:16px;font-weight:650;display:flex;align-items:center;gap:8px}
.fde-compat-mark{width:28px;height:28px;border-radius:var(--dsw-radius-sm,8px);display:flex;align-items:center;justify-content:center;
  background:color-mix(in srgb,var(--fde-warn) 14%,transparent);color:var(--fde-warn-text);font-size:14px;flex:0 0 auto}
.fde-compat-body{font-size:13px;line-height:1.7;color:var(--fde-text-2)}
.fde-compat-body code{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:var(--fde-surface-2);
  padding:1px 5px;border-radius:var(--dsw-radius-xs,4px);color:var(--fde-text)}
.fde-compat-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:2px}
.fde-tip{border-left:0.5px solid var(--fde-border-2);padding-left:10px;font-size:12px;color:var(--fde-text-3);line-height:1.6}

@media (max-width:720px){
  .fde-top{padding:12px 12px 8px}
  .fde-nav-wrap{padding:0 12px 8px}
  .fde-main{padding:2px 12px 20px}
}
/* 窄屏降低 chrome 避让占位（§2.9） */
@media (max-width:1120px){
  .fde-top{padding-top:calc(10px + var(--dsh-frame-top-clearance,0px));
    padding-left:calc(12px + var(--dsh-frame-leading-clearance,0px))}
}
@media (prefers-reduced-motion:reduce){
  .fde-root *{animation-duration:.001ms !important;transition-duration:.001ms !important}
}


/* ---- 资料页（v1.7；ADR 0008）：列表 + 内嵌预览 ---- */
.fde-materials{display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-height:0;position:relative}
.fde-mat-head{display:flex;flex-direction:column;gap:8px;flex:0 0 auto}
.fde-mat-title-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.fde-mat-title{font-size:14px;font-weight:650;color:var(--fde-text)}
.fde-mat-search{width:220px;height:28px;font-size:12px;border-radius:999px}
.fde-mat-filters{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.fde-mat-pills{display:inline-flex;align-items:center;gap:2px;flex-wrap:wrap}
.fde-pill{height:24px;padding:0 9px;border-radius:999px;border:0.5px solid transparent;background:transparent;color:var(--fde-text-2);font-size:12px;cursor:pointer;white-space:nowrap}
.fde-pill.on{background:var(--fde-surface);border-color:var(--fde-border-2);color:var(--fde-text);font-weight:600}
.fde-mat-body{display:flex;gap:10px;flex:1 1 auto;min-height:0}
.fde-mat-list{flex:0 0 380px;min-width:300px;display:flex;flex-direction:column;gap:2px;overflow:auto;padding-right:4px;border-right:0.5px solid var(--fde-border)}
.fde-mat-custs{display:flex;flex-direction:column;gap:2px}
.fde-mat-cust-item{display:flex;flex-direction:column}
.fde-mat-cust{display:flex;align-items:center;gap:6px;padding:7px 8px;border-radius:var(--dsw-radius-sm,8px);cursor:pointer;min-height:32px;user-select:none}
.fde-mat-cust-name{font-size:12px;font-weight:650;color:var(--fde-text);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fde-mat-cust-files{display:flex;flex-direction:column;gap:1px;padding-left:8px}
.fde-mat-recent{display:flex;flex-direction:column;gap:1px}
.fde-mat-file{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:var(--dsw-radius-sm,8px);cursor:pointer;min-width:0}
.fde-mat-file.on{background:color-mix(in srgb,var(--fde-accent) 9%,transparent)}
.fde-mat-file-main{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 auto}
.fde-mat-file-name{font-size:12px;color:var(--fde-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;word-break:break-all}
.fde-mat-file-cust{font-size:11px;color:var(--fde-text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fde-mat-file-meta{font-size:11px;color:var(--fde-text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
.fde-mat-raw{flex:0 0 auto;font-size:10px;color:var(--fde-text-3);border:0.5px solid var(--fde-border);border-radius:999px;padding:0 5px;line-height:16px}
.fde-mat-more{flex:0 0 auto;width:22px;height:22px;border-radius:6px;line-height:1}
.fde-mat-menu-wrap{position:relative;display:inline-flex;flex:0 0 auto}
.fde-mat-menu{position:absolute;right:0;top:24px;z-index:40;min-width:132px;padding:4px;border-radius:var(--dsw-radius-md,12px);background:var(--fde-surface);border:0.5px solid var(--fde-border);box-shadow:0 8px 24px color-mix(in srgb,var(--dsw-alias-label-primary,#000) 16%,transparent)}
.fde-mat-menu-item{display:block;width:100%;text-align:left;padding:6px 9px;border:0;background:transparent;color:var(--fde-text);font-size:12px;border-radius:var(--dsw-radius-sm,8px);cursor:pointer;white-space:nowrap}
.fde-mat-upload{display:flex;flex-direction:column;gap:4px;padding:8px;border:0.5px solid var(--fde-border);border-radius:var(--dsw-radius-md,12px);background:var(--fde-surface);margin-bottom:4px}
.fde-mat-drop{padding:10px}
.fde-mat-materials{margin-top:6px;border-top:0.5px solid var(--fde-border);padding-top:4px}
.fde-mat-subfiles{display:flex;flex-direction:column;gap:1px;padding:2px 0 6px 12px;max-height:240px;overflow:auto}
.fde-mat-subfile{display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:6px}
.fde-mat-preview{flex:1 1 auto;min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--fde-surface);border:0.5px solid var(--fde-border);border-radius:var(--dsw-radius-xl,20px);overflow:hidden}
.fde-mat-preview.full{position:absolute;inset:0;z-index:35;box-shadow:0 18px 48px color-mix(in srgb,var(--dsw-alias-label-primary,#000) 22%,transparent)}
.fde-pv-head{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-bottom:0.5px solid var(--fde-border);flex:0 0 auto;flex-wrap:wrap}
.fde-pv-head-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 240px}
.fde-pv-title{font-size:13px;font-weight:650;color:var(--fde-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fde-pv-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.fde-pv-path{font-size:11px;color:var(--fde-text-3);max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Menlo,monospace}
.fde-pv-actions{display:flex;align-items:center;gap:4px;flex-wrap:wrap;flex:0 0 auto}
.fde-pv-body{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column}
.fde-pv-center{padding:12px;display:flex;justify-content:center;align-items:flex-start;min-height:0}
.fde-pv-img{max-width:100%;height:auto;display:block;border-radius:var(--dsw-radius-sm,8px)}
.fde-pv-frame{flex:1 1 auto;width:100%;min-height:420px;border:0;background:var(--fde-surface-2)}
.fde-pv-pre{margin:0;padding:12px 14px;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.7;color:var(--fde-text);background:transparent}
.fde-pv-html{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}
.fde-pv-subbar{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:0.5px solid var(--fde-border);flex:0 0 auto}
.fde-pv-note{padding:8px 14px;font-size:11px;color:var(--fde-text-3);border-top:0.5px solid var(--fde-border)}
.fde-pv-md{padding:16px 20px;max-width:860px;font-size:13px;line-height:1.75;color:var(--fde-text)}
.fde-md-block{margin:0 0 10px}
.fde-md-p{margin:0 0 8px}
.fde-md-h{margin:14px 0 8px;line-height:1.4;color:var(--fde-text);font-weight:650}
.fde-md-h1{font-size:19px}.fde-md-h2{font-size:17px}.fde-md-h3{font-size:15px}.fde-md-h4,.fde-md-h5,.fde-md-h6{font-size:13px}
.fde-md-hr{border:0;border-top:0.5px solid var(--fde-border);margin:12px 0}
.fde-md-quote{margin:0 0 10px;padding:2px 12px;border-left:2px solid var(--fde-border-2);color:var(--fde-text-2)}
.fde-md-list{margin:0 0 10px;padding-left:20px}
.fde-md-list li{margin:2px 0}
.fde-md-task{list-style:none;margin-left:-18px;display:flex;align-items:flex-start;gap:6px}
.fde-md-task input{margin-top:4px}
.fde-md-pre{margin:0 0 10px;padding:10px 12px;background:var(--fde-surface-2);border-radius:var(--dsw-radius-sm,8px);overflow:auto;font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.6}
.fde-md-code{padding:1px 5px;border-radius:5px;background:var(--fde-surface-2);font-family:ui-monospace,Menlo,monospace;font-size:12px}
.fde-md-link{color:var(--fde-accent);text-decoration:none}
.fde-md-img{display:block;max-width:100%;height:auto;margin:8px 0;border-radius:var(--dsw-radius-sm,8px)}
.fde-md-table-wrap{overflow:auto;margin:0 0 10px}
.fde-md-table{border-collapse:collapse;font-size:12px;min-width:320px}
.fde-md-table th,.fde-md-table td{border:0.5px solid var(--fde-border);padding:5px 8px;text-align:left;vertical-align:top}
.fde-md-table th{background:var(--fde-surface-2);font-weight:650}
.fde-md-fm{display:flex;flex-direction:column;gap:2px;margin:0 0 12px;padding:8px 10px;background:var(--fde-surface-2);border-radius:var(--dsw-radius-sm,8px)}
.fde-md-fm-row{display:flex;gap:8px;font-size:12px}
.fde-md-fm-k{flex:0 0 132px;color:var(--fde-text-3);overflow:hidden;text-overflow:ellipsis}
.fde-md-fm-v{flex:1 1 auto;color:var(--fde-text);word-break:break-word}
/* 左右拖动分隔条（资料页 master-detail） */
.fde-mat-splitter{flex:0 0 7px;margin:0 -3px;border-radius:4px;cursor:col-resize;position:relative;z-index:1;background:transparent;
  border:0;outline:none;touch-action:none}
.fde-mat-splitter::after{content:'';position:absolute;left:3px;top:8px;bottom:8px;width:1px;background:var(--fde-border-2);opacity:.7}
.fde-mat-splitter:focus-visible{outline:none;box-shadow:var(--fde-focus)}
.fde-mat-splitter:active::after{background:var(--fde-accent);opacity:1}
/* 窄面板（容器实测宽度 <860）不上下堆叠，改成「列表 ⇄ 预览」单列切换（见 ArtifactsView.narrow） */
.fde-mat-body.narrow .fde-mat-list{flex:1 1 auto;min-width:0;max-height:none;border-right:0;padding-right:0}
.fde-mat-body.narrow .fde-mat-preview{flex:1 1 auto}
.fde-pv-back{flex:0 0 auto;margin-right:2px}

/* ---- hover 交互（官方 web-styling：:hover 必须位于 @media (hover:hover) 内） ---- */
@media (hover: hover){
  .fde-root ::-webkit-scrollbar-thumb:hover{background:var(--fde-scroll-hover)}
  .fde-iconbtn:hover{border-color:var(--fde-border-2)}
  .fde-nav button:hover{background:var(--fde-hover);color:var(--fde-text)}
  .fde-btn:hover{border-color:var(--fde-border-2);background:var(--fde-surface-3)}
  .fde-btn.primary:hover{background:var(--dsw-alias-button-primary-hover,var(--fde-brand));border-color:transparent}
  .fde-btn.danger:hover{background:color-mix(in srgb,var(--fde-danger) 14%,transparent)}
  .fde-btn.ghost:hover{background:var(--fde-hover)}
  .fde-li-title.clickable:hover{color:var(--fde-accent)}
  .fde-more-item:hover{background:var(--fde-hover)}
  .fde-link:hover{text-decoration:underline}
  .fde-flow-step:hover{border-color:var(--fde-border-2)}
  .fde-flow-tool:hover{border-color:var(--fde-border-2)}
  .fde-lib-card:hover{border-color:var(--fde-border-2)}
  .fde-lib-title:hover{color:var(--fde-accent)}
  .fde-seg button:hover{color:var(--fde-text)}
  .fde-card.draggable:hover{border-color:var(--fde-border-2);box-shadow:0 2px 8px color-mix(in srgb,var(--dsw-alias-label-primary,#000) 8%,transparent)}
  .fde-table tbody tr:hover{background:var(--fde-hover)}
  .fde-drop:hover{border-color:var(--fde-accent)}
  .fde-acc-head:hover{background:var(--fde-hover)}
  .fde-pill:hover{color:var(--fde-text);background:var(--fde-hover)}
  .fde-mat-file:hover{background:var(--fde-hover)}
  .fde-mat-cust:hover{background:var(--fde-hover)}
  .fde-mat-menu-item:hover{background:var(--fde-hover)}
  .fde-mat-subfile:hover{background:var(--fde-hover)}
  .fde-md-link:hover{text-decoration:underline}
  .fde-mat-splitter:hover::after{background:var(--fde-accent);opacity:1}
  .fde-mth button:hover{border-color:var(--fde-border-2);background:var(--fde-surface-3)}
  .fde-drawer-close:hover{background:var(--fde-hover);color:var(--fde-text)}
  .fde-step:hover{border-color:var(--fde-border-2)}
}

`;

    /* ============================================================
     * 三、字典与工具
     * DICT 只放 UI 文案（含经典模式旧文案）；阶段/泳道/门禁的
     * 名称与顺序一律来自 GET /fde/meta，不在客户端硬编码。
     * ============================================================ */
    const DICT = {
      /* 品牌与页签 */
      fdeBrand: 'FDE 工作站',
      fdeTagline: '客户经营 · 注意力 · 会话派发',
      tabToday: '今日', tabCustomers: '客户', tabKnowledge: '情报', tabNavFiles: '资料',
      /* Phase 2 IA（layout.md §7）：5 页签 + 页内子页签 */
      customersViewBoardCustomer: '看板 · 客户', customersViewBoardTask: '看板 · 任务', customersViewList: '客户清单',
      customersViews: '客户视图', knowledgeTabs: '资料子页签', settingsBack: '返回主视图',
      processTabFlow: '8 阶段流程', processTabMethods: '方法库', processTabSkills: '技能与模板', processTabs: '流程子页签',
      compatTitle: '宿主需要重启 DSH 后启用 FDE 看板',
      compatBody: '当前 DSH 宿主还没有提供 FDE 路由（GET /research-workbench/api/fde/meta 不可用）。重启 DSH 后再打开此面板即可使用。',
      compatRetry: '重试探测',
      probing: '正在探测 FDE 宿主能力…',
      /* 通用 */
      loading: '加载中…', refresh: '刷新', refetch: '重新读取',
      empty: '暂无数据', retry: '重试', cancel: '取消', save: '保存', saving: '保存中…',
      confirm: '确认', close: '关闭', edit: '编辑', done: '完成', open: '打开',
      search: '搜索', all: '全部', unknown: '未知',
      handoffFail: '会话创建失败，任务文本已复制到剪贴板，粘贴到对话框即可继续。',
      copied: '已复制任务文本 ✓', pathCopied: '路径已复制', noPath: '拿不到绝对路径，请先点「刷新」',
      revealFail: '系统打开失败', revealOk: '已在 Finder 中显示', openOk: '已在 Finder 中打开',
      /* 今日 */
      todayGreetingMorning: '早上好', todayGreetingNoon: '下午好', todayGreetingEvening: '晚上好',
      todayAttention: '待我处理', todayProposals: '建议', todayFocus: '今日焦点', todayActivity: '最近活动',
      todayEmptyTitle: '今天没有需要你处理的事', todayEmptyBody: '可以推进「今日焦点」里的客户，或看看最近活动。',
      /* Phase 3（v1.5.0）只读演示模式（ADR 0006 / spec §8.8） */
      demoBadge: '演示模式',
      demoBannerText: '演示模式：以下为示例数据，不会写入真实看板',
      demoStart: '开始使用（清除示例）',
      demoLearn: '了解功能（去流程页）',
      demoLocked: '示例模式不可操作；点「开始使用」后即可使用真实数据',
      demoCleared: '已开始使用，示例数据已隐藏',
      demoClearFail: '清除示例失败',
      demoClearing: '正在清除示例…',
      demoCardTitle: '演示数据',
      demoStatusOn: '示例显示中',
      demoStatusOff: '已清除',
      demoCardDesc: '示例数据只读，不会写入看板、也不会创建客户卷；清除后若真实看板仍为空，可从这里重新查看。',
      demoRestore: '重新查看示例数据',
      demoRestoring: '正在恢复示例…',
      demoRestoreBlocked: '有真实数据时不显示示例',
      demoRestored: '已恢复示例数据（只读）',
      demoOnboardTitle: '开始使用 FDE 工作站',
      demoStepRestore: '重新查看示例',
      scanNow: '扫描现有项目',
      actOpen: '打开', actResolve: '解决', actAnswer: '回答', actReview: '审阅', actPass: '通过',
      actReschedule: '改期', actFinish: '完成', actNudge: '跟进', actPause: '暂停',
      actAccept: '采纳', actDismiss: '忽略', actConfirmGate: '去确认',
      /* 招采雷达（v1.1） */
      tabBids: '招采',
      bidTitle: '招采雷达',
      bidNotReady: '招采雷达未就绪（bid-intel 未装载或未升级）',
      bidSearchTitle: '招采检索',
      bidStatsRecords: '入库公告', bidStatsRange: '日期区间', bidStatsSources: '来源', bidStatsUpdated: '索引更新',
      bidSearchPh: '搜索公司 / 采购单位 / 标题 / 全文…', bidSearching: '检索中…', bidSearch: '检索',
      bidModeLabel: '检索模式', bidModeAny: '全文', bidModeCompany: '公司', bidModeBuyer: '采购单位', bidModeTitle: '标题',
      bidFrom: '起始日期', bidTo: '结束日期', bidSource: '来源',
      bidNoResult: '没有命中记录', bidNoResultHint: '换个关键词或日期区间，或先刷新招采索引。',
      bidTotalPrefix: '共 ', bidTotalSuffix: ' 条', bidLoadMore: '加载更多',
      bidBuyer: '采购单位', bidWinner: '中标人', bidAmount: '金额',
      bidAmountTip: '金额为公告原文，不做换算/求和',
      bidCandidatesNote: '候选人 ≠ 中标人：名次只代表评标排序。',
      bidNoCandidates: '公告未解析出候选人。', bidNoUrl: '未提供原文链接。',
      bidOpenSource: '查看原文', bidExpand: '展开', bidCollapse: '收起',
      bidByCustomer: '按客户匹配',
      bidByCustomerHint: '基于客户名称/简称/目录做确定性匹配；点击打开客户抽屉。',
      bidNoCustomerBids: '暂无客户匹配到招采记录。',
      bidImportTitle: '导入公告链接',
      bidImportHint: '仅当 bid-intel 路由可用时显示；导入后写入招采索引。',
      bidImportPh: '公告原文链接（https://…）', bidImport: '导入', bidImporting: '导入中…',
      bidImportOk: '已导入', bidImportFail: '导入失败', bidImportNeedUrl: '请填写公告链接',
      bidRefresh: '刷新招采',
      bidWatchLabel: '招采雷达', bidWatchHint: '关闭后不生成招采信号（bid_signal），不影响看板其它功能',
      bidRelated: '相关', bidTender: '招标', bidAward: '中标', bidCandidateCount: '候选', bidLatest: '最近',
      /* 采样口径：match 只返回采样条数，approxTotal 才是量级（缺失时回退 total） */
      bidRelatedApproxPrefix: '相关 ≈', bidCardTitlePrefix: '招采匹配 ≈',
      bidSamplePrefix: '（采样 ', bidSampleSuffix: ' 条）',
      bidMatchTop: '匹配公告 Top5', bidNoMatch: '未匹配到公告（可检查客户名称/关键词，或点刷新）。',
      bidLinksTitle: '已关联公告', bidNoLinked: '还没有关联公告。', bidNote: '备注',
      bidAddFollowup: '加入跟进', bidLink: '关联', bidLinked: '已关联', bidUnlink: '取消关联',
      bidIdle: '尚未读取招采匹配，点「刷新招采」读取。',
      bidQueries: '查询词',
      bidPageHint: '候选人 ≠ 中标人；金额为公告原文不换算；批次/匹配为推断口径。',
      bidPromoteOk: '已创建跟进任务', bidLinkOk: '已关联公告', bidUnlinkOk: '已取消关联', bidRefreshOk: '招采匹配已刷新',
      bidSettingsLabel: '招标雷达',
      bidSettingsDesc: '开启后生成招采信号建议（bid_signal）；关闭后不生成信号，不影响看板其它功能。',
      bidServiceStatus: '招采索引', bidServiceReady: '可用', bidServiceNotReady: '未就绪',
      /* 流程（v1.3，spec §20.5） */
      tabProcess: '流程',
      processTitle: 'FDE 流程',
      processSubtitle: '从线索到采用的阶段地图：目标 / 输入 / 关键动作 / 交付物 / 工具 / 常见坑 / 门禁，全部从宿主 /fde/meta 读取',
      processClientCountSuffix: ' 个客户',
      processGate: '门禁',
      processGateAuto: '自动检查',
      processGateManual: '人工确认',
      processGateItemSuffix: ' 项门禁（自动/人工）',
      processGoal: '阶段目标',
      processInputs: '输入',
      processActivities: '关键动作',
      processOutputs: '交付物',
      processTools: '工具（点 chips 使用）',
      processPitfalls: '常见坑',
      processNoGate: '该阶段未定义门禁项。',
      processNoPlaybook: '宿主未升级：/fde/meta 未返回阶段 playbook。重启或重载插件后生效；页面其它视图不受影响。',
      processNoMeta: '宿主未返回阶段定义',
      processNoMetaBody: '检查 GET /fde/meta 是否可用；重启 DSH 后刷新页面即可。',
      processHowTo: '在会话中这样用',
      processCopy: '复制',
      processCopied: '已复制 ✓',
      processOpenMethod: '在「方法」页打开',
      processOpenLibrary: '打开资料库',
      processSkillUse: '在会话中这样说：请加载技能「',
      processSkillUseEnd: '」，按本阶段步骤执行，完成后用 fde_item report 回报（≤300 字摘要 + 产物路径）。',
      processToolUse: '在会话中这样说：请调用工具「',
      processToolUseEnd: '」完成本阶段计算/评估，数字以工具输出为准，不要自行估算。',
      processMatrixTitle: '阶段 × 工具矩阵',
      processMatrixHint: '只读；✓ 表示该阶段 playbook 列出的工具。方法/模板 chips 可直接打开文件。',
      processColStage: '阶段',
      processToolSkill: '技能', processToolMethod: '方法', processToolTemplate: '模板',
      processToolTool: '工具', processToolLibrary: '资料库',
      /* 资料库（v1.3，spec §19.6） */
      tabLibrary: '资料库',
      libTitle: 'FDE 资料库',
      libSubtitle: '权威资料 · 开源工具 · 方法模板 · 社区动态；目录人工策展，GitHub 指标与社区每日更新',
      libRefresh: '刷新', libRefreshAria: '刷新资料库', libRefreshing: '刷新中…', libLoading: '正在读取资料库…',
      libToday: '今天',
      libUpdated: '更新于', libVerifiedAt: '核实于',
      libTotalPrefix: '共 ', libTotalSuffix: ' 条',
      libGroupLabel: '来源组',
      libGroupAll: '全部', libGroupIntl: '国外官方', libGroupCn: '国内官方',
      libGroupOpen: '开源工具', libGroupMethod: '方法与模板', libGroupCommunity: '社区动态',
      libKindLabel: '类型', libKindAll: '全部类型',
      libStageLabel: '适用阶段', libStageAll: '全部阶段', libStageAllChip: '全流程',
      libSearchPh: '搜索标题 / 摘要 / 发布方 / 主题…',
      libFeaturedOnly: '仅看重点推荐',
      libSortLabel: '排序', libSortRecommend: '推荐', libSortLatest: '最新', libSortHot: '热度',
      libFeaturedTitle: '本期重点推荐', libFeaturedHint: '按推荐等级与来源组挑出的前 6 条',
      libFeaturedBadge: '★ 重点推荐',
      libNewTag: '新', libUpdatedTag: '更新',
      libAuthA: 'A 官方一手', libAuthB: 'B 二手/媒体', libAuthC: 'C 社区/未核实',
      libWhyPrefix: '为什么看：',
      libStarsPrefix: '★ ', libLicenseLabel: 'license', libPushedLabel: '推送',
      libOpen: '查看原文', libNoUrl: '该条没有可用 https 链接',
      libEmptyTitle: '还没有资料缓存',
      libEmptyBody: '点刷新立即生成；宿主每天也会自动更新（GitHub 指标 + 社区摘要）。',
      libEmptyItems: '资料目录为空',
      libEmptyItemsBody: 'catalog 尚未收录条目；刷新后仍为空请检查宿主日志。',
      libFilterEmpty: '当前筛选下没有资料',
      libFilterEmptyHint: '换个来源组 / 类型 / 阶段或关键词试试，或点「清空筛选」。',
      libResetFilters: '清空筛选',
      libCatalogMissing: '资料目录缺失',
      libCatalogMissingBody: 'catalog 缺失或不可读；资料库主体降级，其它视图不受影响。',
      libStaleWarn: '上次刷新未成功，当前展示旧数据',
      libStaleHint: '缓存不是今天的数据（宿主每日刷新一次）。',
      libLastOk: '上次成功',
      libRefreshOk: '资料库已刷新',
      libRefreshFail: '刷新失败',
      libFootnote: '来源：人工策展目录 + GitHub 每日指标 + 生财社区摘要（只读）；A/B/C 为权威性分级，摘要非全文，以原文为准。',
      /* 看板 */
      boardSearchPh: '搜索客户 / 任务…', boardPriority: '优先级', boardCustomer: '客户',
      boardNoResult: '没有匹配的卡片', boardEmpty: '看板还是空的。先到「客户」导入现有项目。',
      boardDragHint: '拖拽卡片换列；Tab 聚焦后 Enter 打开，Alt+←/→ 换列',
      /* 客户 */
      customersTitle: '客户', customersSearchPh: '搜索客户名 / 公司 / 标签…',
      customersEmpty: '还没有客户。点「新建客户」手动创建，或从 research/ 目录导入现有项目。',
      customersAdopt: '导入现有项目', customersAdoptHint: '先扫描、再人工勾选确认；只写 research/.fde/board.json，不改目录。',
      customersScanning: '正在扫描 research/ 下的现有项目…',
      customersScanEmpty: '没有发现可导入的目录。', customersImport: '导入选中', customersImporting: '正在导入…',
      customersNext: '下一步', customersDue: '到期', customersStay: '停留', customersAttention: '注意力',
      customersDays: '天', customersCount: '个客户',
      customersAlready: '已在看板', customersConfidence: '置信度', customersEvidence: '依据',
      /* 工件 */
      artifactsPick: '选择客户', artifactsNoCustomer: '还没有客户，先导入或新建客户。',
      artifactsUploadTitle: '上传文件到客户卷', artifactsUploadHint: '拖拽文件到此，或点击选择；文件保存到该客户的 raw/uploads/。',
      artifactsUploading: '上传中…', artifactsUploaded: '已上传', artifactsPicker: '选择文件',
      artifactsLoose: '散落文件（research/ 顶层）', artifactsViewFiles: '查看文件', artifactsHideFiles: '收起',
      artifactsExported: '已导出', artifactsNotExported: '未导出', artifactsFiles: '个文件',
      artifactsToProject: '转为项目', artifactsRefresh: '重扫工件',
      /* 资料页（v1.7；ADR 0008） */
      matTitle: '客户资料', matRecent: '最近资料', matByCustomer: '按客户',
      matSearchPh: '搜索文件名 / 客户 / 路径…',
      matAll: '全部', matDoc: '文档', matPdf: 'PDF', matOffice: 'Office', matImage: '图片', matWeb: '网页', matOther: '其他',
      matRawToggle: '原始素材', matRawCount: '原始', matKeyCount: '关键', matRawBadge: '原始',
      matSortRecent: '按最近更新', matSortName: '按名称',
      matUpload: '上传', matReloadOne: '重新加载', matFull: '全屏', matExitFull: '退出全屏',
      matEmpty: '还没有资料', matEmptyHint: '客户卷里出现文件后会自动列在这里；也可以点「上传」放进 raw/uploads/。',
      matNoMatch: '没有匹配的资料', matNoMatchHint: '换个关键词、切换类型，或打开「原始素材」。',
      matBackList: '返回列表',
      matSplitHint: '拖动调整列表宽度（← / → 也可）',
      matPick: '从左侧选择一份资料', matPickHint: '支持 md / txt / PDF / 图片 / 网页快照 / Word / Excel / PPT。',
      matUnsupported: '该格式暂不支持内嵌预览', matUnsupportedHint: '可以用系统应用打开，或在 Finder 中定位。',
      matTextTruncated: '内容较长，已截断显示；完整内容请用系统应用打开。',
      matHtmlSnapshot: '网页快照', matHtmlSource: '源文本',
      matLoadFail: '资料读取失败', matMore: '更多操作', matCopyPath: '复制路径', matSystemOpen: '用系统应用打开',
      matOpenDir: '打开目录', matExport: '导出 PDF', matQa: '质检',
      matOfficeLoading: '正在用 DSH 转换 Office 文档…（首次可能较慢）',
      matOfficeNoSession: 'Office 预览需要本工作区至少有一个会话；请先用系统应用打开。',
      matOfficeFail: 'Office 转换失败',
      matMaterials: '未关联素材', matMaterialsHint: 'research/ 下尚未建客户卷的素材目录与散落文件（只读盘点）。',
      /* 方法 */
      methodsEmpty: '宿主未返回方法清单。', methodsReadFail: '读取失败',
      methodsSkillsHint: '技能由宿主在启动时注册（需重启 DSH 后生效）。',
      skillsEmpty: '宿主未返回技能清单（技能注册需重启 DSH 后生效）。',
      /* 设置 */
      settingsStall: '停滞天数', settingsStallDesc: '活跃阶段停留超过该天数且无近期活动，判定为停滞。',
      settingsWip: 'WIP 上限（进行中）', settingsWipDesc: '进行中任务超过该数量时看板列头提示。',
      settingsSources: '数据源开关', settingsSave: '保存设置', settingsSaved: '设置已保存',
      settingsHealth: '健康检查', settingsHealthRun: '运行健康检查', settingsHealthRunning: '检查中…',
      settingsHealthEmpty: '尚未运行检查。', settingsHealthOk: '全部通过', settingsHealthFail: '存在失败项',
      settingsRestart: '宿主重启提示', settingsRestartBody: 'FDE 宿主路由与技能注册需要重启 DSH 才生效；客户端面板刷新页面即可更新。',
      settingsRules: '规则清单', settingsRedLines: '硬红线（任何模式都不会自动执行）',
      /* 抽屉：客户 */
      drawerEngagement: '客户', drawerItem: '任务', drawerClose: '关闭抽屉',
      drawerStage: '阶段', drawerGate: '门禁清单', drawerGateFor: '进入阶段',
      drawerGateAuto: '自动检查', drawerGateManual: '人工确认', drawerGateEvidencePh: '证据（如：地址锚定 + 三链验证）',
      drawerGateSave: '保存人工确认', drawerGateEvaluate: '重新评估', drawerGateForce: '强制通过',
      drawerGatePassed: '门禁已通过', drawerGatePending: '门禁未通过', drawerGateMissing: '缺项',
      drawerNext: '下一步', drawerNextText: '做什么', drawerNextDue: '到期', drawerNextOwner: '负责人',
      drawerSaveNext: '保存下一步', drawerStakeholders: '干系人', drawerAddStakeholder: '添加干系人',
      drawerName: '姓名', drawerRole: '职务', drawerLevel: '层级', drawerVerified: '已核实',
      drawerArtifacts: '工件', drawerTimeline: '时间线', drawerSession: '关联会话',
      drawerStartSession: '启动会话', drawerPause: '暂停', drawerResume: '恢复', drawerArchive: '归档',
      drawerArchiveConfirm: '归档客户', drawerArchiveBody: '归档只改看板状态，不删除目录与文件。确认归档？',
      drawerForceTitle: '强制推进阶段', drawerForceBody: '门禁未通过。强制推进需要填写理由，并会记录为人工覆盖。',
      drawerForceReason: '强制理由',
      drawerGateMissingTitle: '门禁未通过，暂不能推进', drawerGateGoCheck: '去补门禁',
      drawerNoArtifacts: '暂无工件（可到「工件」视图扫描）。', drawerNoTimeline: '暂无时间线记录。',
      drawerNoStakeholders: '还没有干系人。', drawerPaused: '已暂停', drawerStageMoved: '已推进',
      drawerMoveBackConfirm: '回退阶段', drawerMoveBackBody: '回退阶段会让已通过的门禁状态保留，请确认确实要回退。',
      drawerHandoffPrompt: '已创建会话，正在跳转…',
      /* 抽屉：任务 */
      drawerItemTitle: '任务标题', drawerItemType: '类型', drawerItemLane: '泳道',
      drawerItemPriority: '优先级', drawerItemDue: '到期', drawerItemOwner: '归属',
      drawerItemOwnerHuman: '我', drawerItemOwnerAgent: 'agent', drawerItemOwnerBoth: '协作',
      drawerItemEngagement: '关联客户', drawerItemIndependent: '独立任务',
      drawerSaveItem: '保存任务', drawerReports: '回报历史', drawerReportNow: '人工回报',
      drawerReportKind: '回报类型', drawerReportText: '回报内容', drawerReportSubmit: '提交回报',
      drawerNoReports: '还没有回报。', drawerReportRequired: '回报内容不能为空。',
      drawerDelete: '删除任务', drawerDeleteConfirm: '删除任务', drawerDeleteBody: '删除任务只改看板状态，不影响客户目录。确认删除？',
      drawerEvidenceTitle: '移入「已完成」需要证据', drawerEvidenceBody: '至少提供一条回报或证据文本，写清结果与可检查的产物路径。',
      drawerEvidenceLabel: '证据 / 结果',
      drawerAttention: '待处理问题', drawerAnswerPh: '回答内容（可留空）', drawerResolve: '标记已解决',
      /* 通用错误 / 降级 */
      loadFail: '读取失败', boardLoadFail: '看板读取失败', briefLoadFail: '今日简报读取失败',
      actionFail: '操作失败', retryHint: '可以点「刷新」重试；若持续失败，请重启 DSH 后刷新页面。',
      /* 兼容页/经典模式旧文案 */
      exporting: '已下发导出任务，正在跳转…', methods: '方法 / 参考', back: '返回列表',
      reveal: 'Finder 显示', revealDir: '在 Finder 中打开', openInApp: '打开', copyPath: '复制路径',
    };
    const t = (k) => DICT[k] || k;

    /* ---------- 基础工具 ---------- */
    function pick() {
      for (let i = 0; i < arguments.length; i++) {
        const v = arguments[i];
        if (v !== undefined && v !== null && v !== '') return v;
      }
      return '';
    }
    const asList = (v) => (Array.isArray(v) ? v : []);
    const str = (v) => (v === null || v === undefined ? '' : String(v));
    const pad2 = (n) => (n < 10 ? '0' + n : '' + n);

    function localDate(d) {
      const x = d instanceof Date ? d : new Date(d);
      if (isNaN(x.getTime())) return '';
      return x.getFullYear() + '-' + pad2(x.getMonth() + 1) + '-' + pad2(x.getDate());
    }
    function todayStr() { return localDate(new Date()); }
    function parseDay(s) {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(s));
      if (!m) return null;
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return isNaN(d.getTime()) ? null : d;
    }
    function normDay(v) { const d = parseDay(v); return d ? localDate(d) : ''; }
    function daysBetween(a, b) {
      const da = parseDay(a); const db = parseDay(b);
      if (!da || !db) return null;
      return Math.round((db.getTime() - da.getTime()) / 86400000);
    }
    function fmtDay(s) { const d = parseDay(s); return d ? localDate(d) : str(s); }
    function fmtDateTime(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return str(iso).slice(0, 16).replace('T', ' ');
      return localDate(d) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }
    function relTime(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return str(iso).slice(0, 16).replace('T', ' ');
      const diff = Date.now() - d.getTime();
      if (diff < 0) return fmtDateTime(iso);
      const min = Math.floor(diff / 60000);
      if (min < 1) return '刚刚';
      if (min < 60) return min + ' 分钟前';
      const hr = Math.floor(min / 60);
      if (hr < 24) return hr + ' 小时前';
      const day = Math.floor(hr / 24);
      if (day < 30) return day + ' 天前';
      return fmtDateTime(iso).slice(0, 10);
    }
    function isOverdue(due) {
      const d = parseDay(due);
      return !!d && localDate(d) < todayStr();
    }
    function overdueDays(due) {
      const n = daysBetween(due, todayStr());
      return n === null ? 0 : Math.max(0, n);
    }
    function dueInDays(due) {
      const n = daysBetween(todayStr(), due);
      return n;
    }
    function daysInStage(eng) {
      const since = eng && (eng.stageSince || eng.updatedAt || eng.createdAt);
      if (!since) return null;
      const d = new Date(since);
      if (isNaN(d.getTime())) return null;
      return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
    }
    function greeting() {
      const hr = new Date().getHours();
      if (hr < 12) return t('todayGreetingMorning');
      if (hr < 18) return t('todayGreetingNoon');
      return t('todayGreetingEvening');
    }
    function fmtMoney(v) {
      const n = Number(v && v.amount);
      if (!v || !n) return '';
      try { return '¥' + n.toLocaleString('zh-CN'); } catch (e) { return '¥' + n; }
    }

    /* ---------- 词表回退（仅用于 meta 缺字段时，不含阶段顺序） ---------- */
    const PRIORITY_FALLBACK = { high: '高', normal: '中', low: '低' };
    const TYPE_FALLBACK = {
      research: '调研', meeting: '会面', solution: '方案', pilot: '试点',
      delivery: '交付', adoption: '采用', followup: '跟进', admin: '杂务',
    };
    const AUTONOMY_FALLBACK = {
      observe: { label: '只建议', desc: '只生成建议；所有动作都需要人确认' },
      assisted: { label: '建议 + 一键', desc: '安全动作可一键执行；门禁、对外材料、删除/归档仍需人确认' },
      auto: { label: '自动安全动作', desc: '安全动作自动执行；阶段推进、门禁、对外、删除仍只能由人执行' },
    };
    const ATTENTION_FALLBACK = {
      blocked: '受阻', decision: '待决定', review: '待审阅', answer: '待回答',
      overdue: '逾期', gate: '门禁待确认', stall: '停滞', proposal: '建议',
    };
    const REDLINE_FALLBACK = [
      '推进客户阶段', '通过门禁', '标记交付/验收完成', '导出或发送对外材料',
      '删除客户或任务', '修改客户卷定稿文件',
    ];
    const LEVEL_FALLBACK = { top: '一把手', vp: '分管', exec: '执行层', unknown: '未知' };

    /* ---------- meta 归一化（阶段/泳道/门禁唯一来源） ---------- */
    function normCheck(x, type) {
      if (typeof x === 'string') return { key: x, label: x, type: type || '' };
      const o = x && typeof x === 'object' ? x : {};
      const key = str(pick(o.key, o.name, o.label));
      return { key, label: str(pick(o.label, o.name, o.key, key)), type: str(pick(o.type, type)) };
    }
    function normNamed(x, fallbackMap) {
      if (typeof x === 'string') return { key: x, label: (fallbackMap && fallbackMap[x]) || x, desc: '' };
      const o = x && typeof x === 'object' ? x : {};
      const key = str(pick(o.key, o.name, o.ruleId, o.id));
      return {
        key,
        label: str(pick(o.label, o.name, (fallbackMap && fallbackMap[key]), key)),
        desc: str(pick(o.desc, o.description, o.definition, o.condition, '')),
      };
    }

    function normalizeMeta(raw) {
      const m = raw && typeof raw === 'object' ? raw : {};
      const stages = asList(m.stages).map((s, i) => {
        if (typeof s === 'string') return { key: s, label: s, gate: s, order: i, definition: '' };
        const o = s && typeof s === 'object' ? s : {};
        return {
          key: str(pick(o.key, o.name)),
          label: str(pick(o.label, o.name, o.key)),
          gate: str(pick(o.gate, o.gateKey, o.key)),
          order: typeof o.order === 'number' ? o.order : i,
          definition: str(pick(o.definition, o.desc, o.description)),
          playbook: normalizePlaybook(o.playbook),
        };
      }).filter((s) => s.key);
      stages.sort((a, b) => a.order - b.order);

      const lanes = asList(m.lanes).map((l, i) => {
        if (typeof l === 'string') return { key: l, label: l, board: true, wip: null, order: i };
        const o = l && typeof l === 'object' ? l : {};
        return {
          key: str(pick(o.key, o.name)), label: str(pick(o.label, o.name, o.key)),
          board: o.board !== false, wip: typeof o.wip === 'number' ? o.wip : null,
          order: typeof o.order === 'number' ? o.order : i,
          definition: str(pick(o.definition, o.desc, '')),
        };
      }).filter((l) => l.key);
      lanes.sort((a, b) => a.order - b.order);
      const boardLaneKeys = asList(m.boardLanes).map(str).filter(Boolean);
      let boardLanes;
      if (boardLaneKeys.length) {
        boardLanes = boardLaneKeys.map((k) => lanes.find((l) => l.key === k) || { key: k, label: k, board: true, wip: null });
      } else {
        boardLanes = lanes.filter((l) => l.board !== false);
      }
      if (!boardLanes.length) boardLanes = lanes;

      const gates = {};
      const rawGates = m.gates && typeof m.gates === 'object' ? m.gates : {};
      Object.keys(rawGates).forEach((k) => {
        const g = rawGates[k] && typeof rawGates[k] === 'object' ? rawGates[k] : {};
        gates[k] = {
          key: str(pick(g.key, k)), label: str(pick(g.label, k)), stage: str(g.stage),
          auto: asList(g.auto).map((x) => normCheck(x, 'auto')),
          manual: asList(g.manual).map((x) => normCheck(x, 'manual')),
        };
      });
      asList(m.gateList).forEach((g) => {
        if (!g || !g.key) return;
        if (gates[g.key]) return;
        gates[g.key] = {
          key: str(g.key), label: str(pick(g.label, g.key)), stage: str(g.stage),
          auto: asList(g.auto).map((x) => normCheck(x, 'auto')),
          manual: asList(g.manual).map((x) => normCheck(x, 'manual')),
        };
      });

      const attentionKinds = {};
      asList(m.attentionKinds).forEach((x) => {
        const o = typeof x === 'string' ? { key: x } : (x || {});
        if (!o.key) return;
        attentionKinds[str(o.key)] = {
          label: str(pick(o.label, o.key)),
          actions: asList(o.actions).map(str).filter(Boolean),
          target: str(o.target || ''),
        };
      });

      const defaults = m.defaults && typeof m.defaults === 'object' ? m.defaults : {};
      const settingsDefaults = defaults.settings && typeof defaults.settings === 'object' ? defaults.settings : {};

      return {
        version: m.version,
        apiPrefix: str(m.apiPrefix || ''),
        stages,
        terminalStages: asList(m.terminalStages)
          .map((x) => str(typeof x === 'string' ? x : (x && (x.key || x.name))))
          .filter(Boolean),
        lanes,
        boardLanes,
        gates,
        itemTypes: asList(m.itemTypes).map((x) => normNamed(x, TYPE_FALLBACK)).filter((x) => x.key),
        priorities: asList(m.priorities).map((x) => normNamed(x, PRIORITY_FALLBACK)).filter((x) => x.key),
        autonomyModes: asList(m.autonomyModes).map((x) => normNamed(x, null)).filter((x) => x.key),
        attentionKinds,
        rules: asList(m.rules).map((x) => normNamed(x, null)).filter((x) => x.key),
        redLines: asList(m.redLines).map((x) => str(typeof x === 'string' ? x : (x && (x.label || x.text)))).filter(Boolean),
        defaults,
        settingsDefaults,
        skills: asList(m.skills).map((x) => ({ name: str(x && x.name), description: str(x && x.description) })).filter((x) => x.name),
      };
    }

    function stageOf(meta, key) { return (meta && meta.stages || []).find((s) => s.key === key) || null; }
    function stageLabel(meta, key) {
      const s = stageOf(meta, key);
      if (s) return s.label || s.key;
      if (meta && meta.terminalStages && meta.terminalStages.indexOf(key) !== -1) {
        return key === 'archived' ? '已归档' : (key === 'lost' ? '已流失' : key);
      }
      return key || '—';
    }
    function stageIndex(meta, key) { return (meta && meta.stages || []).findIndex((s) => s.key === key); }
    function laneOf(meta, key) { return (meta && meta.lanes || []).find((l) => l.key === key) || null; }
    function laneLabel(meta, key) {
      const l = laneOf(meta, key);
      if (l) return l.label || l.key;
      return key || '—';
    }
    function gateOfStage(meta, stageKey) {
      const s = stageOf(meta, stageKey);
      const gk = str(pick(s && s.gate, stageKey));
      if (meta && meta.gates && meta.gates[gk]) return meta.gates[gk];
      if (meta && meta.gates && meta.gates[stageKey]) return meta.gates[stageKey];
      return { key: gk, label: stageLabel(meta, stageKey), stage: stageKey, auto: [], manual: [] };
    }
    function gateStateOf(eng, stageKey) {
      const gs = eng && eng.gateState && eng.gateState[stageKey];
      return gs && typeof gs === 'object' ? gs : null;
    }
    function manualChecksOf(eng, stageKey) {
      const gs = gateStateOf(eng, stageKey);
      const checks = gs && gs.checks && typeof gs.checks === 'object' ? gs.checks : {};
      return checks;
    }
    function manualProgress(eng, meta, stageKey) {
      const def = gateOfStage(meta, stageKey);
      const manual = def.manual || [];
      if (!manual.length) return null;
      const checks = manualChecksOf(eng, stageKey);
      let pass = 0;
      manual.forEach((c) => {
        const st = checks[c.key];
        if (st && (st.status === 'pass' || st === true)) pass += 1;
      });
      return { pass, total: manual.length };
    }
    function isActiveEngagement(eng, meta) {
      if (!eng) return false;
      if (eng.paused) return false;
      const key = str(eng.stage);
      if (meta && meta.terminalStages && meta.terminalStages.indexOf(key) !== -1) return false;
      if (meta && meta.stages && meta.stages.length) return stageIndex(meta, key) !== -1;
      return true;
    }
    function findEngagement(board, id) {
      if (!board || !id) return null;
      return asList(board.engagements).find((e) => e && e.id === id) || null;
    }
    function findItem(board, id) {
      if (!board || !id) return null;
      return asList(board.items).find((i) => i && i.id === id) || null;
    }
    function engagementNameOf(board, id, fallback) {
      const eng = findEngagement(board, id);
      return eng ? str(pick(eng.shortName, eng.name, eng.company)) : str(fallback || '');
    }
    function autonomyKey(meta, board) {
      const fromBoard = board && board.settings && board.settings.autonomy;
      if (fromBoard) return str(fromBoard);
      if (meta && meta.settingsDefaults && meta.settingsDefaults.autonomy) return str(meta.settingsDefaults.autonomy);
      return 'observe';
    }
    function autonomyMeta(meta, key) {
      const modes = (meta && meta.autonomyModes && meta.autonomyModes.length)
        ? meta.autonomyModes
        : Object.keys(AUTONOMY_FALLBACK).map((k) => ({ key: k, label: AUTONOMY_FALLBACK[k].label, desc: AUTONOMY_FALLBACK[k].desc }));
      const found = modes.find((m) => m.key === key);
      if (found) return { key, label: found.label, desc: found.desc };
      return { key, label: key, desc: '' };
    }
    function attentionMeta(meta, kind) {
      const def = meta && meta.attentionKinds && meta.attentionKinds[kind];
      let label = '';
      if (typeof def === 'string') label = def;
      else if (def && typeof def === 'object') label = str(def.label);
      return { kind, label: label || ATTENTION_FALLBACK[kind] || str(kind) };
    }
    function priorityLabel(meta, key) {
      const p = ((meta && meta.priorities) || []).find((x) => x.key === key);
      if (p) return p.label;
      return PRIORITY_FALLBACK[key] || key || '中';
    }
    function typeLabel(meta, key) {
      const x = ((meta && meta.itemTypes) || []).find((y) => y.key === key);
      if (x) return x.label;
      return TYPE_FALLBACK[key] || key;
    }
    function levelLabel(meta, key) { return LEVEL_FALLBACK[key] || key || LEVEL_FALLBACK.unknown; }
    function redLinesOf(meta) {
      return (meta && meta.redLines && meta.redLines.length) ? meta.redLines : REDLINE_FALLBACK;
    }

    /* ---------- 注意力 / 建议 / 焦点 / 活动 归一化 ---------- */
    function normalizeAttention(list, board) {
      return asList(list).map((a, i) => {
        const o = a && typeof a === 'object' ? a : { text: str(a) };
        const kind = str(o.kind || 'default');
        let engagementId = str(pick(o.engagementId, o.engId));
        let itemId = str(o.itemId);
        if (!engagementId && o.target === 'engagement') engagementId = str(o.id);
        if (!itemId && o.target === 'item') itemId = str(o.id);
        let proposalId = str(o.proposalId);
        if (kind === 'proposal' && !proposalId) proposalId = str(o.id);
        if (!engagementId && o.engagementName && board) {
          const hit = asList(board.engagements).find((e) => e && (
            e.name === o.engagementName || e.shortName === o.engagementName || e.company === o.engagementName));
          if (hit) engagementId = str(hit.id);
        }
        return {
          key: 'attn-' + i,
          kind,
          rank: typeof o.rank === 'number' ? o.rank : i,
          text: str(pick(o.title, o.text, o.detail, o.question, '')),
          detail: str(o.detail || ''),
          engagementId,
          engagementName: str(pick(o.engagementName, o.engName)),
          itemId,
          proposalId,
          due: str(o.due || ''),
          days: typeof o.days === 'number' ? o.days : null,
          actions: asList(o.actions).map((x) => str(x)).filter(Boolean),
          raw: o,
        };
      }).filter((a) => a.text || a.engagementId || a.itemId);
    }
    function normalizeProposals(list) {
      return asList(list).map((p, i) => {
        const o = p && typeof p === 'object' ? p : {};
        return {
          key: str(pick(o.id, 'prp-' + i)), id: str(o.id), ruleId: str(o.ruleId),
          title: str(pick(o.title, o.text, '建议')), detail: str(o.detail),
          kind: str(o.kind), status: str(o.status || 'pending'),
          engagementId: str(o.engagementId), itemId: str(o.itemId),
          payload: o.payload || {}, createdAt: str(o.createdAt),
        };
      }).filter((p) => p.id);
    }
    function normalizeFocus(list, board) {
      return asList(list).map((f, i) => {
        if (typeof f === 'string') {
          const eng = findEngagement(board, f);
          return eng ? { key: eng.id, engagement: eng, reason: '', name: '' } : null;
        }
        const o = f && typeof f === 'object' ? f : {};
        const id = str(pick(o.engagementId, o.id));
        let eng = findEngagement(board, id);
        if (!eng && o.name) {
          eng = asList(board && board.engagements).find((e) => e && (e.name === o.name || e.shortName === o.name)) || null;
        }
        return {
          key: id || 'focus-' + i,
          engagement: eng,
          reason: str(pick(o.reason, o.why)),
          name: str(pick(o.name, eng && eng.name)),
        };
      }).filter(Boolean);
    }
    function normalizeActivity(list) {
      return asList(list).map((a, i) => {
        const o = a && typeof a === 'object' ? a : {};
        return {
          key: 'act-' + i, at: str(o.at), kind: str(o.kind || 'note'), text: str(o.text),
          engagementId: str(o.engagementId), itemId: str(o.itemId),
        };
      }).filter((a) => a.text);
    }
    function normalizeBrief(raw, board, meta) {
      const b = raw && typeof raw === 'object' ? raw : {};
      const proposals = Array.isArray(b.proposals)
        ? normalizeProposals(b.proposals)
        : normalizeProposals(asList(board && board.proposals).filter((p) => p && p.status === 'pending'));
      return {
        headline: str(b.headline),
        attention: normalizeAttention(b.attention, board),
        proposals,
        focus: normalizeFocus(b.focus, board),
        activity: normalizeActivity(b.activity),
        stats: b.stats && typeof b.stats === 'object' ? b.stats : {},
        autonomy: str(b.autonomy),
        generatedAt: str(b.generatedAt),
      };
    }

    /* ---------- 派生：统计 / 今日焦点 / 工件数 ---------- */
    function computeStats(board, meta) {
      const engs = asList(board && board.engagements);
      const items = asList(board && board.items);
      const activeEngs = engs.filter((e) => isActiveEngagement(e, meta));
      const active = activeEngs.length;
      const today = todayStr();
      let dueToday = 0;
      let overdue = 0;
      activeEngs.forEach((e) => {
        const due = normDay(e.nextAction && e.nextAction.due);
        if (!due) return;
        if (due === today) dueToday += 1;
        if (due < today) overdue += 1;
      });
      items.forEach((it) => {
        if (!it || !it.due) return;
        const due = normDay(it.due);
        if (due === today) dueToday += 1;
      });
      const pendingProposals = asList(board && board.proposals).filter((p) => p && p.status === 'pending').length;
      return { active, dueToday, overdue, proposalsPending: pendingProposals };
    }
    function buildFocus(board, meta, n) {
      const limit = n || 3;
      const active = asList(board && board.engagements).filter((e) => isActiveEngagement(e, meta));
      const pScore = (p) => (p === 'high' ? 0 : p === 'low' ? 2 : 1);
      return active.map((e) => {
        const due = normDay(e.nextAction && e.nextAction.due);
        const dd = due ? daysBetween(todayStr(), due) : null;
        const stay = daysInStage(e) || 0;
        return {
          key: e.id,
          engagement: e,
          reason: '',
          score: pScore(e.priority) * 100 + (dd === null ? 50 : Math.max(-500, Math.min(500, dd))) + stay * 0.01,
        };
      }).sort((a, b) => a.score - b.score).slice(0, limit);
    }
    function engagementArtifactCount(eng) {
      const a = eng && eng.artifacts;
      if (typeof a === 'number') return a;
      if (Array.isArray(a)) return a.length;
      if (a && typeof a === 'object') {
        if (typeof a.total === 'number') return a.total;
        const md = typeof a.md === 'number' ? a.md : null;
        const pdf = typeof a.pdf === 'number' ? a.pdf : null;
        if (md !== null) return md + (pdf || 0);
        const keys = Object.keys(a).filter((k) => typeof a[k] === 'number');
        if (keys.length) return keys.reduce((sum, k) => sum + a[k], 0);
        return Object.keys(a).length;
      }
      return null;
    }
    function attentionCountOf(eng, items) {
      let n = 0;
      if (eng && eng.attention) n += 1;
      asList(items).forEach((it) => { if (it && it.engagementId === (eng && eng.id) && it.attention) n += 1; });
      return n;
    }


    /* ============================================================
     * 招采雷达（v1.1）：面板只做「客户关联层」。
     * 检索/分类/报告语义归 @local/bid-intel；FDE 只调只读服务。
     * 降级：所有 bids 响应 available=false → 显示未就绪，不报错不白屏。
     * 口径：候选人 ≠ 中标人；金额只展示公告原文（不换算/不求和）；
     *      批次/匹配是推断口径，报告里必须说明。
     * ============================================================ */
    const BID_RELATION_KEYS = {
      buyer: 'bidRelBuyer', winner: 'bidRelWinner', candidate: 'bidRelCandidate',
      mention: 'bidRelMention', tender: 'bidRelTender',
    };

    function bidRelationMeta(rel) {
      const key = str(rel).toLowerCase();
      const tone = key === 'winner' ? 'ok' : (key === 'candidate' ? 'warn' : (key === 'mention' ? 'muted' : 'accent'));
      const label = BID_RELATION_KEYS[key] ? t(BID_RELATION_KEYS[key]) : t('bidRelNotice');
      return { key: key || 'notice', label, tone };
    }

    /* 检索结果没有 relation 时，按公告类型推导展示徽章（不改变语义） */
    function bidRelationDerived(item) {
      const rel = str(item && item.relation).toLowerCase();
      if (rel) return rel;
      const kind = str(item && item.kind);
      if (/中标|成交|结果/.test(kind)) return 'winner';
      if (/候选/.test(kind)) return 'candidate';
      return 'tender';
    }

    function normalizeBidItem(raw, idx) {
      const o = raw && typeof raw === 'object' ? raw : {};
      const amounts = asList(o.amounts).map((x) => str(x)).filter(Boolean);
      const candidates = asList(o.candidates).map((c, i) => {
        if (typeof c === 'string') return { key: 'c-' + i, name: c, rank: null };
        const co = c && typeof c === 'object' ? c : {};
        return {
          key: str(pick(co.id, 'c-' + i)),
          name: str(pick(co.name, co.company)),
          rank: typeof co.rank === 'number' ? co.rank : (typeof co.place === 'number' ? co.place : null),
        };
      }).filter((c) => c.name);
      const id = str(pick(o.id, o.bidId, ''));
      const amountText = str(pick(o.amount, o.amountText, '')) || amounts.join('；');
      return {
        key: id || ('bid-' + idx),
        id,
        title: str(pick(o.title, o.name, '（无标题）')),
        date: str(o.date),
        buyer: str(o.buyer),
        winner: str(o.winner),
        candidates,
        amounts,
        amountText,
        url: str(o.url),
        source: str(o.source),
        kind: str(o.kind),
        projectNo: str(pick(o.project_no, o.projectNo)),
        excerpt: str(pick(o.excerpt, o.summary, '')),
        relation: str(pick(o.relation, '')),
        note: str(pick(o.note, '')),
        linkedAt: str(pick(o.linkedAt, '')),
        by: str(pick(o.by, '')),
        tender: !!o.tender,
        award: !!o.award,
      };
    }

    function normalizeBidLink(raw) {
      const o = raw && typeof raw === 'object' ? raw : {};
      return {
        key: str(pick(o.bidId, o.id, '')),
        bidId: str(pick(o.bidId, o.id, '')),
        title: str(pick(o.title, '（已关联公告）')),
        date: str(o.date || ''),
        url: str(o.url || ''),
        relation: str(o.relation || ''),
        note: str(o.note || ''),
        linkedAt: str(o.linkedAt || ''),
        by: str(o.by || ''),
      };
    }

    function normalizeBidStatsResp(raw) {
      const r = raw && typeof raw === 'object' ? raw : {};
      const st = r.stats && typeof r.stats === 'object' ? r.stats : {};
      const dm = r.dataMeta && typeof r.dataMeta === 'object' ? r.dataMeta : {};
      const records = typeof st.records === 'number' ? st.records : (typeof dm.records === 'number' ? dm.records : null);
      const available = r.available === undefined ? (r.ok !== false && records !== null) : !!r.available;
      let mtime = '';
      if (dm.mtime) {
        const d = new Date(dm.mtime);
        if (!isNaN(d.getTime())) mtime = d.toISOString();
        else mtime = str(dm.mtime);
      }
      return {
        available,
        reason: str(r.reason || ''),
        records,
        sources: asList(st.sources).map((s) => {
          const so = s && typeof s === 'object' ? s : { name: str(s) };
          return { name: str(pick(so.name, so.id, so.source)), count: Number(so.count) || 0 };
        }).filter((s) => s.name),
        dateRange: asList(st.dateRange).map((x) => str(x)),
        years: st.years && typeof st.years === 'object' ? st.years : {},
        withWinner: Number(st.withWinner) || 0,
        withBuyer: Number(st.withBuyer) || 0,
        withAmount: Number(st.withAmount) || 0,
        generatedAt: str(st.generatedAt || ''),
        file: str(pick(dm.file, st.file, '')),
        mtime,
        bytes: Number(pick(dm.bytes, st.bytes, 0)) || 0,
      };
    }

    function normalizeBidSearchResp(raw) {
      const r = raw && typeof raw === 'object' ? raw : {};
      const items = asList(r.items).map((x, i) => normalizeBidItem(x, i));
      const available = r.available === undefined ? r.ok !== false : !!r.available;
      return {
        available,
        reason: str(r.reason || ''),
        total: typeof r.total === 'number' ? r.total : items.length,
        direct: typeof r.direct === 'number' ? r.direct : null,
        mentioned: typeof r.mentioned === 'number' ? r.mentioned : null,
        items,
        facets: r.facets && typeof r.facets === 'object' ? r.facets : null,
      };
    }

    function normalizeBidMatchResp(raw) {
      const r = raw && typeof raw === 'object' ? raw : {};
      const st = r.stats && typeof r.stats === 'object' ? r.stats : {};
      const items = asList(r.items).map((x, i) => normalizeBidItem(x, i));
      const linked = asList(r.linked).map(normalizeBidLink).filter((l) => l.bidId);
      const available = r.available === undefined ? r.ok !== false : !!r.available;
      return {
        available,
        reason: str(r.reason || ''),
        stats: {
          total: typeof st.total === 'number' ? st.total : items.length,
          approxTotal: approxTotalOf(st, typeof st.total === 'number' ? st.total : items.length),
          tender: Number(st.tender) || 0,
          award: Number(st.award) || 0,
          candidate: Number(st.candidate) || 0,
          latest: str(st.latest || ''),
        },
        queries: asList(r.queries).map((x) => str(x)).filter(Boolean),
        items,
        linked,
      };
    }

    /* board 里每个 engagement 的 bids 摘要（spec §17.2 派生字段） */
    function engagementBids(eng) {
      const b = eng && eng.bids;
      if (!b || typeof b !== 'object') {
        return { available: false, total: 0, approxTotal: 0, tender: 0, award: 0, candidate: 0, latest: '', matches: [], queries: [] };
      }
      const total = Number(b.total) || 0;
      return {
        available: b.available !== false,
        total,
        approxTotal: approxTotalOf(b, total),
        tender: Number(b.tender) || 0,
        award: Number(b.award) || 0,
        candidate: Number(b.candidate) || 0,
        latest: str(b.latest || ''),
        matches: asList(b.matches).map((x, i) => normalizeBidItem(x, i)).slice(0, 5),
        queries: asList(b.queries).map((x) => str(x)).filter(Boolean),
      };
    }

    function normalizeBoardBidStats(board) {
      const b = board && board.bidStats;
      if (!b || typeof b !== 'object') return null;
      return {
        available: b.available !== false,
        records: typeof b.records === 'number' ? b.records : null,
        dateRange: asList(b.dateRange).map((x) => str(x)),
        engagedCount: Number(b.engagedCount) || 0,
      };
    }

    function bidRangeText(range) {
      const a = asList(range);
      if (!a.length || (!a[0] && !a[1])) return '—';
      return (a[0] || '?') + ' ~ ' + (a[1] || '?');
    }

    function bidSourcesText(stats) {
      const list = asList(stats && stats.sources);
      if (!list.length) return '—';
      return list.map((s) => s.name + (s.count ? ' ' + s.count : '')).join(' · ');
    }

    function bidLinkedIdSet(match) {
      const set = {};
      asList(match && match.linked).forEach((l) => { if (l.bidId) set[l.bidId] = l; });
      return set;
    }

    function normalizeSourceSettings(src) {
      const base = { folderWatch: true, briefOnOpen: true, bidWatch: true };
      const o = src && typeof src === 'object' ? src : {};
      Object.keys(base).forEach((k) => { if (typeof o[k] === 'boolean') base[k] = o[k]; });
      return base;
    }

    /* 生财情报授权来源（ADR 0004 D5 / §5）：面板只展示来源与过期时间，token 永不回显 */
    const SCYS_SOURCE_TEXT = { link: '链接授权', env: '环境变量', compat: '兼容文件（不推荐）', none: '未授权' };
    function scysSourceText(src) { return SCYS_SOURCE_TEXT[str(src)] || '未授权'; }

    function BidUnavailable(props) {
      const p = props || {};
      return h('div', { className: 'fde-bid-unavailable', role: 'status' },
        h('span', { className: 'fde-bid-unavailable-mark', 'aria-hidden': 'true' }, '!'),
        h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
          h('div', { style: { fontWeight: 600 } }, t('bidNotReady')),
          p.reason ? h('div', { className: 'fde-hint' }, '原因：' + p.reason) : null),
        p.onRetry ? h(Btn, { small: true, onClick: p.onRetry }, t('retry')) : null);
    }

    /* 采样量级：宿主返回 approxTotal（真实量级）与 total（采样条数）；缺失时回退 total。 */
    function approxTotalOf(source, total) {
      const raw = source && (source.approxTotal != null ? source.approxTotal
        : (source.approx_total != null ? source.approx_total : null));
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : total;
    }

    function bidRelatedBadgeText(stats) {
      const st = stats || {};
      const total = Number(st.total) || 0;
      const approx = approxTotalOf(st, total);
      if (!total && !approx) return t('bidRelated') + ' 0';
      return t('bidRelatedApproxPrefix') + approx + t('bidSamplePrefix') + total + t('bidSampleSuffix');
    }

    function bidCardBadgeTitle(bids) {
      const b = bids || {};
      const total = Number(b.total) || 0;
      const approx = approxTotalOf(b, total);
      return t('bidCardTitlePrefix') + approx + t('bidSamplePrefix') + total + t('bidSampleSuffix')
        + (b.latest ? '，最近 ' + fmtDay(b.latest) : '');
    }

    function bidStatBadges(match) {
      const st = (match && match.stats) || {};
      return [
        h(Chip, { key: 'total', tone: 'accent', children: bidRelatedBadgeText(st) }),
        h(Chip, { key: 'tender', tone: 'on', children: t('bidTender') + ' ' + (st.tender || 0) }),
        h(Chip, { key: 'award', tone: 'ok', children: t('bidAward') + ' ' + (st.award || 0) }),
        h(Chip, { key: 'cand', tone: 'warn', children: t('bidCandidateCount') + ' ' + (st.candidate || 0) }),
        st.latest ? h(Chip, { key: 'latest', tone: 'muted', children: t('bidLatest') + ' ' + fmtDay(st.latest) }) : null,
      ];
    }

    /* ============================================================
     * 四、通用组件
     * 全部普通函数组件（无 JSX），只用 h()。按钮 32px、圆角 8px、
     * 选中态用 accent 描边 + 轻微背景，遵循宿主管理页密度。
     * ============================================================ */
    function Spinner() { return h('span', { className: 'fde-spinner', 'aria-hidden': 'true' }); }

    function Btn(props) {
      const p = props || {};
      const cls = 'fde-btn' + (p.kind ? ' ' + p.kind : '') + (p.small ? ' small' : '') + (p.className ? ' ' + p.className : '');
      return h('button', {
        type: p.type || 'button',
        className: cls,
        disabled: !!p.disabled,
        title: p.title || undefined,
        'aria-label': p.ariaLabel || p.title || undefined,
        'aria-disabled': p.disabled ? 'true' : undefined,
        style: p.style || undefined,
        onClick: p.onClick || undefined,
      }, p.busy
        ? [h(React.Fragment, { key: 'spinner' }, Spinner()), h(React.Fragment, { key: 'content' }, p.children)]
        : p.children);
    }

    function Chip(props) {
      const p = props || {};
      const cls = 'fde-chip' + (p.tone ? ' ' + p.tone : '') + (p.className ? ' ' + p.className : '');
      return h('span', { className: cls, title: p.title || undefined }, p.children);
    }

    function Card(props) {
      const p = props || {};
      return h('div', { className: 'fde-card' + (p.className ? ' ' + p.className : ''), style: p.style || undefined }, p.children);
    }

    function Section(props) {
      const p = props || {};
      /* 数组 children 里未带 key 的元素补一个稳定 key：调用点用 [h(...), h(...)] 字面量数组很常见，
         在 Section 一处归一，避免 14 个调用点逐个维护。cloneElement 只改 key，不增 DOM 层。 */
      const kids = Array.isArray(p.children)
        ? p.children.map((c, i) => (c && typeof c === 'object' && c.$$typeof && (c.key === undefined || c.key === null)
          ? React.cloneElement(c, { key: 'sec-' + i })
          : c))
        : p.children;
      return h('div', { className: 'fde-section' + (p.className ? ' ' + p.className : '') },
        h('div', { className: 'fde-section-head' },
          h('div', { className: 'fde-section-title' }, p.title),
          p.extra || null,
          h('div', { className: 'fde-spacer' }),
          p.actions || null),
        kids);
    }

    function Empty(props) {
      const p = props || {};
      return h('div', { className: 'fde-empty', role: 'status' },
        h('div', { className: 'fde-empty-mark', 'aria-hidden': 'true' }, p.mark || '·'),
        p.title ? h('div', { className: 'fde-empty-title' }, p.title) : null,
        p.children || p.body ? h('div', null, p.children || p.body) : null,
        p.actions || null);
    }

    function Loading(props) {
      const p = props || {};
      return h('div', { className: 'fde-loading', role: 'status' }, Spinner(), h('span', null, p.text || t('loading')));
    }

    function ErrorLine(props) {
      const p = props || {};
      return h('div', { className: 'fde-error', role: 'alert' },
        h('div', { style: { flex: '1 1 auto' } },
          h('div', { style: { fontWeight: 600 } }, p.title || t('loadFail')),
          h('div', { style: { opacity: 0.9 } }, p.text || '')),
        p.onRetry ? h(Btn, { small: true, onClick: p.onRetry }, p.retryLabel || t('retry')) : null);
    }

    function MsgLine(props) {
      const p = props || {};
      if (!p.text) return null;
      return h('div', { className: 'fde-msg' + (p.kind ? ' ' + p.kind : ''), role: p.kind === 'err' ? 'alert' : 'status' },
        h('span', { style: { flex: '1 1 auto', minWidth: 0 } }, p.text),
        p.onClose ? h('button', { type: 'button', className: 'fde-drawer-close', 'aria-label': t('close'), onClick: p.onClose }, '×') : null);
    }

    function Field(props) {
      const p = props || {};
      return h('div', { className: 'fde-field' + (p.full ? ' fde-full' : ''), style: p.style || undefined },
        p.label ? h('label', null, p.label) : null,
        p.children,
        p.hint ? h('div', { className: 'fde-hint' }, p.hint) : null);
    }

    function TextInput(props) {
      const p = props || {};
      return h('input', {
        className: 'fde-input' + (p.className ? ' ' + p.className : ''),
        type: p.type || 'text',
        value: p.value === undefined || p.value === null ? '' : p.value,
        placeholder: p.placeholder || undefined,
        'aria-label': p.ariaLabel || undefined,
        disabled: !!p.disabled,
        readOnly: !!p.readOnly,
        onChange: p.onChange || undefined,
        onKeyDown: p.onKeyDown || undefined,
        style: p.style || undefined,
      });
    }

    function TextArea(props) {
      const p = props || {};
      return h('textarea', {
        className: 'fde-textarea' + (p.className ? ' ' + p.className : ''),
        value: p.value === undefined || p.value === null ? '' : p.value,
        placeholder: p.placeholder || undefined,
        'aria-label': p.ariaLabel || undefined,
        disabled: !!p.disabled,
        rows: p.rows || 3,
        onChange: p.onChange || undefined,
        style: p.style || undefined,
      });
    }

    function Select(props) {
      const p = props || {};
      const options = asList(p.options);
      return h('select', {
        className: 'fde-select' + (p.className ? ' ' + p.className : ''),
        value: p.value === undefined || p.value === null ? '' : p.value,
        'aria-label': p.ariaLabel || undefined,
        disabled: !!p.disabled,
        onChange: p.onChange || undefined,
        style: p.style || undefined,
      }, options.map((o) => {
        const val = typeof o === 'string' ? o : str(o.value);
        const label = typeof o === 'string' ? o : str(pick(o.label, o.value));
        return h('option', { key: val, value: val }, label);
      }));
    }

    function Checkbox(props) {
      const p = props || {};
      return h('label', { className: 'fde-check', title: p.title || undefined },
        h('input', {
          type: 'checkbox',
          checked: !!p.checked,
          disabled: !!p.disabled,
          'aria-label': p.ariaLabel || p.label || undefined,
          onChange: (e) => { if (p.onChange) p.onChange(!!(e && e.target && e.target.checked)); },
        }),
        p.label ? h('span', null, p.label) : null);
    }

    function Dot(props) {
      const p = props || {};
      return h('span', { className: 'fde-dot' + (p.tone ? ' ' + p.tone : ''), 'aria-hidden': 'true' });
    }

    function AutonomyBadge(props) {
      const p = props || {};
      const info = autonomyMeta(p.meta, p.mode);
      return h('span', {
        className: 'fde-autonomy ' + (p.mode || 'observe'),
        title: info.desc || '',
      }, h('span', null, '自主性'), h('b', null, info.label));
    }

    function Stat(props) {
      const p = props || {};
      return h('div', { className: 'fde-stat' + (p.tone ? ' ' + p.tone : '') },
        h('div', { className: 'fde-stat-num' }, p.num === undefined || p.num === null ? '—' : String(p.num)),
        h('div', { className: 'fde-stat-label' }, p.label));
    }

    function KeyValue(props) {
      const p = props || {};
      const rows = asList(p.rows).filter((r) => r && r[1] !== undefined && r[1] !== null && r[1] !== '');
      return h('div', { className: 'fde-kv' },
        rows.map((r, i) => h('div', { key: 'kv-' + i, style: { display: 'contents' } },
          h('div', { className: 'fde-kv-k' }, r[0]),
          h('div', { className: 'fde-kv-v' }, r[1]))));
    }

    function MissingList(props) {
      const p = props || {};
      const items = asList(p.items).map((m, i) => {
        if (typeof m === 'string') return { key: 'm-' + i, label: m, type: '' };
        return { key: str(pick(m && m.key, 'm-' + i)), label: str(pick(m && m.label, m && m.key)), type: str(m && m.type) };
      });
      if (!items.length) return null;
      return h('ul', { className: 'fde-missing' },
        items.map((m) => h('li', { key: m.key },
          m.label,
          m.type ? h('span', { className: 'fde-hint', style: { marginLeft: 6 } }, m.type === 'manual' ? '（人工确认）' : '（自动检查）') : null)));
    }

    /* 通用确认弹层：破坏性操作、强制推进、证据输入都走这里。
       二次确认 + 行内校验，不使用原生 confirm/alert。 */
    function ConfirmDialog(props) {
      const p = props || {};
      const [value, setValue] = useState(p.initialValue || '');
      const [err, setErr] = useState('');
      const input = p.input || null;
      const titleId = 'fde-modal-title';
      const submit = () => {
        const v = input ? str(value).trim() : '';
        if (input && input.required && !v) { setErr(input.requiredHint || '请填写后再确认'); return; }
        if (p.onConfirm) p.onConfirm(v);
      };
      return h('div', { className: 'fde-modal-mask', role: 'presentation', onClick: p.onCancel || undefined },
        h('div', {
          className: 'fde-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId,
          onClick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); },
          onKeyDown: (e) => { if (e && e.key === 'Escape' && p.onCancel) p.onCancel(); },
        },
          h('div', { className: 'fde-modal-head' },
            h('div', { className: 'fde-modal-title' + (p.danger ? ' danger' : ''), id: titleId }, p.title || t('confirm'))),
          h('div', { className: 'fde-modal-body' },
            p.body ? h('div', { className: 'fde-note' }, p.body) : null,
            p.children || null,
            input ? h(Field, { label: input.label || '' },
              input.multiline
                ? h(TextArea, {
                  value: value,
                  placeholder: input.placeholder || '',
                  ariaLabel: input.label || '',
                  onChange: (e) => { setErr(''); setValue(e.target.value); },
                })
                : h(TextInput, {
                  value: value,
                  placeholder: input.placeholder || '',
                  ariaLabel: input.label || '',
                  onChange: (e) => { setErr(''); setValue(e.target.value); },
                  onKeyDown: (e) => { if (e && e.key === 'Enter') submit(); },
                })) : null,
            err ? h('div', { className: 'fde-msg err', role: 'alert' }, err) : null),
          h('div', { className: 'fde-modal-foot' },
            h(Btn, { onClick: p.onCancel || undefined }, p.cancelLabel || t('cancel')),
            h(Btn, {
              kind: p.danger ? 'danger' : 'primary',
              onClick: submit,
              disabled: !!p.busy,
            }, p.confirmLabel || t('confirm')))));
    }

    /* 新建客户 / 新建任务弹层（Phase 0 §2.1）。
       字段以宿主 create 契约为准：
         engagement → {name, company, source:{kind,ref}, nextAction:{text,owner,due}, priority}
         item       → {title, type, priority, owner, due, engagementId, stage(泳道)}
       校验/失败都行内提示；成功由父组件刷新 board 并打开新对象抽屉。 */
    function CreateDialog(props) {
      const p = props || {};
      const kind = p.kind === 'item' ? 'item' : 'engagement';
      const meta = p.meta;
      const board = p.board || {};
      const engs = asList(board.engagements);
      const priorities = asList(meta && meta.priorities);
      const itemTypes = asList(meta && meta.itemTypes);
      const lanes = asList(meta && meta.boardLanes);
      const prioOptions = (priorities.length
        ? priorities
        : [{ key: 'high', label: '高' }, { key: 'normal', label: '中' }, { key: 'low', label: '低' }])
        .map((x) => ({ value: x.key, label: x.label || x.key }));
      const [name, setName] = useState('');
      const [source, setSource] = useState('');
      const [nextText, setNextText] = useState('');
      const [nextOwner, setNextOwner] = useState('');
      const [nextDue, setNextDue] = useState('');
      const [priority, setPriority] = useState('normal');
      const [title, setTitle] = useState('');
      const [itemType, setItemType] = useState(itemTypes[0] ? itemTypes[0].key : 'research');
      const [owner, setOwner] = useState('');
      const [due, setDue] = useState('');
      const [engagementId, setEngagementId] = useState('');
      const [lane, setLane] = useState(lanes[0] ? lanes[0].key : 'inbox');
      const [busy, setBusy] = useState(false);
      const [err, setErr] = useState('');

      const submit = async () => {
        if (busy) return;
        let payload;
        if (kind === 'engagement') {
          const nm = str(name).trim();
          if (!nm) { setErr('请填写公司全称'); return; }
          payload = {
            name: nm,
            company: nm,
            source: { kind: 'manual', ref: str(source).trim() },
            nextAction: { text: str(nextText).trim(), owner: str(nextOwner).trim(), due: str(nextDue).trim() },
            priority: priority || 'normal',
          };
        } else {
          const ti = str(title).trim();
          if (!ti) { setErr('请填写任务标题'); return; }
          payload = {
            title: ti,
            type: itemType || 'research',
            priority: priority || 'normal',
            owner: str(owner).trim(),
            due: str(due).trim(),
            engagementId: engagementId || '',
            stage: lane || 'inbox',
          };
        }
        setBusy(true); setErr('');
        let r;
        try {
          r = p.onSubmit ? await p.onSubmit(payload) : { ok: false, reason: '面板未接线' };
        } catch (e) {
          r = { ok: false, reason: errText(e) };
        }
        setBusy(false);
        if (!r || r.ok === false) { setErr((r && r.reason) || '创建失败'); return; }
        if (p.onCreated) p.onCreated(r);
      };

      const fields = kind === 'engagement' ? [
        h(Field, { key: 'name', full: true, label: '公司全称（必填）' },
          h(TextInput, {
            value: name, placeholder: '如：某集团有限公司', ariaLabel: '公司全称',
            onChange: (e) => { setErr(''); setName(e.target.value); },
          })),
        h(Field, { key: 'source', label: '来源' },
          h(TextInput, {
            value: source, placeholder: '行业展会 / 老客户介绍 / 招标公告…', ariaLabel: '来源',
            onChange: (e) => setSource(e.target.value),
          })),
        h(Field, { key: 'prio', label: '优先级' },
          h(Select, { value: priority, ariaLabel: '优先级', options: prioOptions, onChange: (e) => setPriority(e.target.value) })),
        h(Field, { key: 'next', full: true, label: '下一步：做什么' },
          h(TextInput, {
            value: nextText, placeholder: '如：约分管副总做 30 分钟需求访谈', ariaLabel: '下一步',
            onChange: (e) => setNextText(e.target.value),
          })),
        h(Field, { key: 'nextOwner', label: '下一步负责人' },
          h(TextInput, {
            value: nextOwner, placeholder: '如：张三', ariaLabel: '下一步负责人',
            onChange: (e) => setNextOwner(e.target.value),
          })),
        h(Field, { key: 'nextDue', label: '下一步何时（到期日）' },
          h(TextInput, { type: 'date', value: nextDue, ariaLabel: '下一步到期日', onChange: (e) => setNextDue(e.target.value) })),
      ] : [
        h(Field, { key: 'title', full: true, label: '任务标题（必填）' },
          h(TextInput, {
            value: title, placeholder: '如：整理会后跟进清单', ariaLabel: '任务标题',
            onChange: (e) => { setErr(''); setTitle(e.target.value); },
          })),
        h(Field, { key: 'type', label: '类型' },
          h(Select, {
            value: itemType, ariaLabel: '类型',
            options: (itemTypes.length ? itemTypes : [{ key: 'research', label: '调研' }]).map((x) => ({ value: x.key, label: x.label || x.key })),
            onChange: (e) => setItemType(e.target.value),
          })),
        h(Field, { key: 'prio', label: '优先级' },
          h(Select, { value: priority, ariaLabel: '优先级', options: prioOptions, onChange: (e) => setPriority(e.target.value) })),
        h(Field, { key: 'owner', label: '负责人' },
          h(TextInput, {
            value: owner, placeholder: '如：张三（留空=我）', ariaLabel: '负责人',
            onChange: (e) => setOwner(e.target.value),
          })),
        h(Field, { key: 'due', label: '截止日期' },
          h(TextInput, { type: 'date', value: due, ariaLabel: '截止日期', onChange: (e) => setDue(e.target.value) })),
        h(Field, { key: 'eng', label: '关联客户' },
          h(Select, {
            value: engagementId, ariaLabel: '关联客户',
            options: [{ value: '', label: '（不关联）' }].concat(
              engs.map((e) => ({ value: e.id, label: e.shortName || e.name || e.dir || e.id }))),
            onChange: (e) => setEngagementId(e.target.value),
          })),
        h(Field, { key: 'lane', label: '初始泳道' },
          h(Select, {
            value: lane, ariaLabel: '初始泳道',
            options: (lanes.length ? lanes : [{ key: 'inbox', label: '收件箱' }]).map((x) => ({ value: x.key, label: x.label || x.key })),
            onChange: (e) => setLane(e.target.value),
          })),
      ];

      return h('div', {
        className: 'fde-modal-mask',
        role: 'presentation',
        onClick: p.onClose || undefined,
      },
        h('div', {
          className: 'fde-modal',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': kind === 'item' ? '新建任务' : '新建客户',
          onClick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); },
          onKeyDown: (e) => { if (e && e.key === 'Escape' && p.onClose) p.onClose(); },
        },
          h('div', { className: 'fde-modal-head' },
            h('div', { className: 'fde-modal-title' }, kind === 'item' ? '新建任务' : '新建客户')),
          h('div', { className: 'fde-modal-body' },
            h('div', { className: 'fde-form-grid' }, fields),
            kind === 'engagement'
              ? h('div', { className: 'fde-hint' }, '新建后进入「线索」阶段；阶段推进与门禁仍需人工确认。')
              : h('div', { className: 'fde-hint' }, '任务只写入 research/.fde/board.json，不改动客户目录。'),
            err ? h('div', { className: 'fde-msg err', role: 'alert' }, err) : null),
          h('div', { className: 'fde-modal-foot' },
            h(Btn, { onClick: p.onClose }, t('cancel')),
            h(Btn, { kind: 'primary', busy, onClick: submit }, busy ? '创建中…' : '创建'))));
    }

    /* 行内编辑的小提示：键盘操作说明 */
    function KeyHint(props) {
      const p = props || {};
      return h('span', { className: 'fde-hint' },
        p.children || [
          h('span', { key: 'tab', className: 'fde-kbd' }, 'Tab'), ' 聚焦 · ',
          h('span', { key: 'enter', className: 'fde-kbd' }, 'Enter'), ' 打开 · ',
          h('span', { key: 'alt', className: 'fde-kbd' }, 'Alt+←/→'), ' 换列',
        ]);
    }

    /* 优先级小点 + 文本 */
    function PriorityTag(props) {
      const p = props || {};
      return h('span', { className: 'fde-prio', title: (p.label || '') + '优先级' },
        Dot({ tone: p.value === 'high' ? 'high' : (p.value === 'low' ? 'low' : 'normal') }),
        h('span', null, p.label || priorityLabel(p.meta, p.value)));
    }

    /* ============================================================
     * Phase 2 IA（layout.md §7）：5 页签 + 页内子页签。
     * 旧 view 值（board/library/bids/artifacts/methods）由 normalizeView 映射，
     * 未知值回落「今日」，保证旧深链/旧 state 不白屏。
     * ============================================================ */
    const NAV_VIEWS = ['today', 'customers', 'knowledge', 'process', 'files'];
    const LEGACY_VIEW_ALIASES = {
      board: 'customers', library: 'knowledge', bids: 'knowledge', artifacts: 'files', methods: 'process',
    };
    function normalizeView(key) {
      const k = str(key);
      if (k === 'settings' || NAV_VIEWS.indexOf(k) !== -1) return k;
      return LEGACY_VIEW_ALIASES[k] || 'today';
    }

    /* ============================================================
     * Phase 3（v1.5.0）只读演示模式（ADR 0006 / spec §8.8）
     * - DEMO_* 是纯客户端合成数据：不写 board、不建客户卷（只读覆盖层）；
     * - 触发：真实看板为空且 settings.demoDismissed !== true；
     * - 写操作由 demoGuard() 在“传输层”统一拦截（postJSON/fdePost + runAction），
     *   并给行内提示，避免任何一处漏拦截写脏真实看板。
     * ============================================================ */
    const demoRuntime = { active: false, notify: null };
    function demoGuard(fn) {
      return function demoGuarded() {
        const opts = arguments.length > 3 ? arguments[3] : null;
        if (demoRuntime.active && !(opts && opts.demoBypass)) {
          const reason = str(DICT.demoLocked || '示例模式不可操作；点「开始使用」后即可使用真实数据');
          try { if (typeof demoRuntime.notify === 'function') demoRuntime.notify('warn', reason); } catch (e) { /* ignore */ }
          return Promise.resolve({ ok: false, demoBlocked: true, reason });
        }
        return fn.apply(null, arguments);
      };
    }

    function demoDate(offsetDays) {
      const d = new Date();
      d.setDate(d.getDate() + (offsetDays || 0));
      const m = d.getMonth() + 1;
      const day = d.getDate();
      return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
    }
    function demoIso(offsetDays, hour) {
      const d = new Date();
      d.setDate(d.getDate() + (offsetDays || 0));
      d.setHours(typeof hour === 'number' ? hour : 9, 0, 0, 0);
      return d.toISOString();
    }
    function demoEngagement(spec) {
      return Object.assign({
        paused: false, owner: '示例', tags: ['示例'], stakeholders: [],
        source: { kind: 'demo', ref: '内置示例（不写入看板）', at: demoIso(-1, 9) },
        value: { amount: 0, currency: 'CNY', note: '示例数字，不构成报价' },
        gateState: {},
        timeline: [],
        bidWatch: false,
      }, spec, {
        company: spec.company || spec.name,
        dir: spec.dir || ('demo-' + spec.id),
        stageSince: demoIso(-(spec.stayDays || 1), 9),
      });
    }

    /* 示例客户的阶段只记「meta.stages 的第几个」（stageIndex），渲染时由 demoBoardView 解析成 key；
       客户端不硬编码阶段 key/顺序（spec §16.5 / 审计断言）。 */
    const DEMO_ENGAGEMENTS = [
      demoEngagement({
        id: 'demo-eng-1', name: '某集团（示例）', shortName: '某集团', stageIndex: 0, priority: 'high', stayDays: 1,
        nextAction: { text: '补齐客户来源与可检查的下一步', due: demoDate(2), owner: '示例' },
      }),
      demoEngagement({
        id: 'demo-eng-2', name: '某研究院（示例）', shortName: '某研究院', stageIndex: 1, priority: 'normal', stayDays: 5,
        nextAction: { text: '完成主体锁定与三链验证', due: demoDate(0), owner: '示例' },
        attention: { kind: 'decision' },
        timeline: [{ at: demoIso(-2, 10), kind: 'note', text: '（示例）线索转研判' }],
      }),
      demoEngagement({
        id: 'demo-eng-3', name: '某材料（示例）', shortName: '某材料', stageIndex: 2, priority: 'high', stayDays: 9,
        nextAction: { text: '准备会面 Brief 与合作地图', due: demoDate(-1), owner: '示例' },
        attention: { kind: 'review' },
        timeline: [{ at: demoIso(-1, 15), kind: 'report', text: '（示例）会面 Brief 初稿已生成' }],
      }),
      demoEngagement({
        id: 'demo-eng-4', name: '某能源（示例）', shortName: '某能源', stageIndex: 3, priority: 'normal', stayDays: 12,
        nextAction: { text: '确认一期场景与数据可得性', due: demoDate(3), owner: '示例' },
        timeline: [{ at: demoIso(-3, 11), kind: 'note', text: '（示例）需求池收敛到 1 个场景' }],
      }),
    ];

    const DEMO_ITEMS = [
      { id: 'demo-itm-scoping', engagementId: 'demo-eng-4', title: '整理场景评估表 12 维评分（示例）', type: 'scoping', stage: 'todo', priority: 'high', due: demoDate(2), owner: 'agent', reports: [], attention: null, createdAt: demoIso(-1, 9) },
      { id: 'demo-itm-discovery', engagementId: 'demo-eng-2', title: '补齐数据源清单与接口人（示例）', type: 'research', stage: 'doing', priority: 'normal', due: demoDate(-1), owner: 'agent', reports: [], attention: null, createdAt: demoIso(-2, 9) },
      { id: 'demo-itm-meeting', engagementId: 'demo-eng-3', title: '等待客户确认会面时间（示例）', type: 'meeting', stage: 'waiting', priority: 'normal', due: demoDate(4), owner: '示例', reports: [], attention: null, createdAt: demoIso(-3, 9) },
    ];

    const DEMO_ACTIVITY = [
      { at: demoIso(-1, 16), kind: 'report', text: '（示例）任务「补齐数据源清单」回报 progress', engagementId: 'demo-eng-2', itemId: 'demo-itm-discovery', by: 'agent' },
      { at: demoIso(-1, 11), kind: 'note', text: '（示例）某材料：会面 Brief 初稿已生成', engagementId: 'demo-eng-3', by: 'agent' },
      { at: demoIso(-2, 15), kind: 'stage', text: '（示例）某研究院：线索推进到研判', engagementId: 'demo-eng-2', by: 'human' },
      { at: demoIso(-3, 10), kind: 'created', text: '（示例）某能源：纳入看板', engagementId: 'demo-eng-4', by: 'human' },
    ];

    const DEMO_BOARD = {
      version: 1, revision: 0, updatedAt: demoIso(0, 9), demo: true,
      settings: { autonomy: 'observe', demoDismissed: false, stallDays: 14, wipLimits: { doing: 5 }, sources: { folderWatch: true, briefOnOpen: true, bidWatch: true } },
      engagements: DEMO_ENGAGEMENTS, items: DEMO_ITEMS, proposals: [], activity: DEMO_ACTIVITY,
    };

    const DEMO_BRIEF = {
      headline: '演示数据：4 个示例客户 · 3 个示例任务 · 2 条注意力',
      greeting: '（示例数据）先看它跑起来长什么样；点顶部「开始使用（清除示例）」即可换成你的真实客户。',
      attention: [
        {
          key: 'demo-attn-decision', kind: 'decision', engagementId: 'demo-eng-2', engagementName: '某研究院（示例）',
          text: '需要决定：某研究院（示例）｜一期场景选「采购比价」还是「合同审查」？', due: demoDate(1), days: 5,
          detail: '（示例）点「开始使用」后即可处理真实注意力',
        },
        {
          key: 'demo-attn-review', kind: 'review', engagementId: 'demo-eng-3', engagementName: '某材料（示例）',
          text: '待审阅：某材料（示例）会面 Brief 初稿', due: demoDate(2), days: 9,
          detail: '（示例数据，只读）',
        },
      ],
      proposals: [],
      focus: [],
      activity: DEMO_ACTIVITY.map((a, i) => ({ key: 'demo-act-' + i, at: a.at, kind: a.kind, text: a.text, engagementId: a.engagementId, itemId: a.itemId })),
      stats: { active: 4, dueToday: 1, overdue: 1 },
    };

    function isBoardEmpty(board) {
      return asList(board && board.engagements).length === 0 && asList(board && board.items).length === 0;
    }
    function isDemoEligible(board) {
      const settings = board && board.settings;
      return !!board && isBoardEmpty(board) && !(settings && settings.demoDismissed === true);
    }
    function demoBoardView(board, meta) {
      const base = board && typeof board === 'object' ? board : {};
      const stages = asList(meta && meta.stages);
      const engagements = DEMO_ENGAGEMENTS.map((e) => {
        const st = stages[e.stageIndex];
        const out = Object.assign({}, e, { stage: st ? str(st.key) : '', gateState: {} });
        delete out.stageIndex;
        return out;
      });
      return Object.assign({}, base, {
        demo: true,
        settings: Object.assign({}, base.settings || {}, { demoDismissed: false }),
        engagements,
        items: DEMO_ITEMS,
        proposals: [],
        activity: DEMO_ACTIVITY,
      });
    }

    /* ============================================================
     * 五、今日视图
     * 注意力列表（blocked/decision/review/answer/overdue/gate/stall/proposal）
     * + 建议（采纳/忽略）+ 今日焦点 + 最近活动 + 战况统计。
     * ============================================================ */
    const ATTENTION_ORDER = ['blocked', 'decision', 'review', 'answer', 'overdue', 'gate', 'stall', 'proposal'];

    function attnTone(kind) {
      const idx = ATTENTION_ORDER.indexOf(kind);
      if (idx === -1) return 'default';
      return kind;
    }

    function builtinAttentionActions(kind) {
      if (kind === 'proposal') return [{ key: 'accept', label: t('actAccept'), kind: 'primary' }, { key: 'dismiss', label: t('actDismiss') }];
      if (kind === 'blocked') return [{ key: 'resolve', label: t('actResolve'), kind: 'primary' }, { key: 'open', label: t('actOpen') }];
      if (kind === 'decision' || kind === 'answer') return [{ key: 'resolve', label: t('actAnswer'), kind: 'primary' }, { key: 'open', label: t('actOpen') }];
      if (kind === 'review') return [{ key: 'open', label: t('actReview'), kind: 'primary' }, { key: 'finish', label: t('actPass') }];
      if (kind === 'overdue') return [{ key: 'open', label: t('actReschedule'), kind: 'primary' }, { key: 'finish', label: t('actFinish') }];
      if (kind === 'gate') return [{ key: 'open', label: t('actConfirmGate'), kind: 'primary' }];
      if (kind === 'stall') return [{ key: 'open', label: t('actNudge'), kind: 'primary' }, { key: 'pause', label: t('actPause') }];
      return [{ key: 'open', label: t('actOpen'), kind: 'primary' }];
    }

    /* 宿主 attention actions 是语义 key（open/resolve/answer/accept/pass/...），
       这里翻译成中文按钮，并把处理动作交给根组件统一分发。 */
    const ATTENTION_ACTION_MAP = {
      open: { key: 'open', label: '打开' },
      resolve: { key: 'resolve', label: '解决' },
      answer: { key: 'answer', label: '回答' },
      accept: { key: 'accept', label: '采纳' },
      dismiss: { key: 'dismiss', label: '忽略' },
      pass: { key: 'pass', label: '通过' },
      return: { key: 'return', label: '退回' },
      reschedule: { key: 'reschedule', label: '改期' },
      done: { key: 'done', label: '完成' },
      confirm: { key: 'confirm', label: '去确认' },
      followup: { key: 'followup', label: '跟进' },
      pause: { key: 'pause', label: '暂停' },
      finish: { key: 'finish', label: '完成' },
    };

    function normalizeAttnActions(a) {
      const raw = asList(a.actions);
      if (!raw.length) return builtinAttentionActions(a.kind);
      return raw.map((x, i) => {
        const rawKey = typeof x === 'string' ? x : str(x && (x.key || x.action));
        const mapped = ATTENTION_ACTION_MAP[rawKey] || { key: rawKey, label: rawKey };
        return {
          key: mapped.key,
          label: mapped.label,
          kind: (i === 0 || mapped.key === 'accept' || mapped.key === 'pass') ? 'primary' : '',
        };
      });
    }

    function TodayView(props) {
      const p = props || {};
      const meta = p.meta;
      const board = p.board;
      /* 待处理按 kind 分组折叠（§2.6）：默认每组 top-2；行操作最多 2 个（多余进「⋯」） */
      const [expandedKinds, setExpandedKinds] = useState({});
      const [openMenu, setOpenMenu] = useState('');
      const brief = p.brief || { attention: [], proposals: [], focus: [], activity: [], stats: {} };
      const stats = p.stats || {};
      const autonomy = autonomyKey(meta, board);
      const attention = asList(brief.attention);
      const proposals = asList(brief.proposals);
      const focus = asList(brief.focus).length ? brief.focus : buildFocus(board, meta, 3);
      const activity = asList(brief.activity).slice(0, 10);
      const boardEmpty = asList(board && board.engagements).length === 0;
      /* 统计数字只在下方统计条出现一次（§2.6 今日去重），这里不再拼重复数字 */
      const groups = (() => {
        const map = {};
        attention.forEach((a) => {
          const k = str(a && a.kind) || 'default';
          (map[k] = map[k] || []).push(a);
        });
        const ordered = ATTENTION_ORDER.filter((k) => map[k] && map[k].length)
          .concat(Object.keys(map).filter((k) => ATTENTION_ORDER.indexOf(k) === -1));
        return ordered.map((k) => ({ kind: k, rows: map[k] }));
      })();

      /* 注意力行：kind 已提到分组头，行内只放标题/元信息/动作；
         动作最多 2 个（主操作 + 次操作），超过 2 个折叠进「⋯」菜单（§2.6）。 */
      const attentionRow = (a) => {
        const name = a.engagementName || engagementNameOf(board, a.engagementId, '');
        const actions = normalizeAttnActions(a);
        const visible = actions.slice(0, 2);
        const overflow = actions.slice(2);
        const fire = (act) => { setOpenMenu(''); if (p.onAttentionAction) p.onAttentionAction(a, act.key); };
        return h('div', { className: 'fde-li', key: a.key },
          h('div', { className: 'fde-li-main' },
            h('button', {
              type: 'button',
              className: 'fde-li-title clickable',
              style: { background: 'transparent', border: 0, padding: 0, textAlign: 'left', font: 'inherit', color: 'inherit' },
              onClick: () => p.onAttentionOpen && p.onAttentionOpen(a),
            }, a.text),
            h('div', { className: 'fde-li-meta' },
              name ? Chip({ children: name }) : null,
              a.due ? h('span', { className: isOverdue(a.due) ? 'fde-warn' : '' }, '到期 ' + fmtDay(a.due)) : null,
              a.days ? h('span', null, '停 ' + a.days + ' 天') : null,
              a.detail ? h('span', { className: 'fde-dim', style: { wordBreak: 'break-all' } }, a.detail) : null)),
          h('div', { className: 'fde-li-actions' },
            visible.map((act) => h(Btn, {
              key: a.key + '-' + act.key,
              small: true,
              kind: act.kind || '',
              onClick: () => fire(act),
            }, act.label)),
            overflow.length
              ? h('div', { className: 'fde-more' },
                h(Btn, {
                  small: true,
                  ariaLabel: '更多操作',
                  busy: false,
                  onClick: () => setOpenMenu((cur) => (cur === a.key ? '' : a.key)),
                }, '⋯'),
                openMenu === a.key
                  ? h('div', { className: 'fde-more-menu', role: 'menu' },
                    overflow.map((act) => h('button', {
                      key: a.key + '-more-' + act.key,
                      type: 'button',
                      role: 'menuitem',
                      className: 'fde-more-item',
                      onClick: () => fire(act),
                    }, act.label)))
                  : null)
              : null));
      };

      const proposalRow = (pr) => {
        const engName = engagementNameOf(board, pr.engagementId, '');
        return h('div', { className: 'fde-li', key: pr.key },
          h('div', { className: 'fde-li-main' },
            h('div', { className: 'fde-li-title' }, pr.title),
            h('div', { className: 'fde-li-meta' },
              pr.ruleId ? Chip({ children: pr.ruleId }) : null,
              engName ? Chip({ children: engName }) : null,
              pr.detail ? h('span', { className: 'fde-dim', style: { wordBreak: 'break-all' } }, pr.detail) : null)),
          h('div', { className: 'fde-li-actions' },
            h(Btn, {
              small: true, kind: 'primary', disabled: p.busy === 'prp:' + pr.id,
              onClick: () => p.onProposalAction && p.onProposalAction(pr, 'accept'),
            }, t('actAccept')),
            h(Btn, {
              small: true, disabled: p.busy === 'prp:' + pr.id,
              onClick: () => p.onProposalAction && p.onProposalAction(pr, 'dismiss'),
            }, t('actDismiss'))));
      };

      const focusRow = (f) => {
        const eng = f.engagement || findEngagement(board, f.key);
        if (!eng) {
          return h('div', { className: 'fde-li', key: f.key },
            h('div', { className: 'fde-li-main' }, h('div', { className: 'fde-li-title' }, f.name || '—')));
        }
        const next = eng.nextAction || {};
        const stay = daysInStage(eng);
        return h('button', {
          type: 'button',
          className: 'fde-li',
          key: f.key,
          style: { background: 'transparent', border: 0, width: '100%', textAlign: 'left', font: 'inherit', color: 'inherit', cursor: 'pointer' },
          onClick: () => p.onOpenEngagement && p.onOpenEngagement(eng.id),
        },
          h('div', { className: 'fde-li-main' },
            h('div', { className: 'fde-li-title' }, eng.name || eng.company || eng.dir || '—'),
            h('div', { className: 'fde-li-meta' },
              Chip({ tone: 'on', children: stageLabel(meta, eng.stage) }),
              PriorityTag({ value: eng.priority, label: priorityLabel(meta, eng.priority), meta }),
              next.text ? h('span', { style: { wordBreak: 'break-all' } }, next.text) : h('span', { className: 'fde-dim' }, t('boardNoNext')),
              next.due ? h('span', { className: isOverdue(next.due) ? 'fde-warn' : '' }, fmtDay(next.due)) : null,
              stay !== null ? h('span', { className: 'fde-dim' }, '停留 ' + stay + ' 天') : null,
              f.reason ? h('span', { className: 'fde-dim' }, f.reason) : null)));
      };

      const activityRow = (a) => {
        const eng = findEngagement(board, a.engagementId);
        const clickable = !!eng;
        return h('div', { className: 'fde-li', key: a.key },
          h('div', { className: 'fde-li-main' },
            h('div', {
              className: 'fde-li-title' + (clickable ? ' clickable' : ''),
              style: { fontWeight: 500, fontSize: 13 },
              role: clickable ? 'button' : undefined,
              tabIndex: clickable ? 0 : undefined,
              onClick: clickable ? () => p.onOpenEngagement && p.onOpenEngagement(eng.id) : undefined,
              onKeyDown: clickable ? (e) => { if (e && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); p.onOpenEngagement && p.onOpenEngagement(eng.id); } } : undefined,
            }, a.text),
            h('div', { className: 'fde-li-meta' },
              eng ? Chip({ children: eng.shortName || eng.name }) : null,
              h('span', { className: 'fde-dim' }, relTime(a.at)))));
      };

      /* 一句战况：示例态用 DEMO_BRIEF.greeting；真实态用定性描述（数字只在 KPI 出现一次，§2.6） */
      const battleLine = str(brief.greeting)
        || (attention.length
          ? '先处理要你拍板的事；建议与焦点用于判断下一步。'
          : '今天没有待你处理的事；可以推进焦点客户或看看最近变化。');

      /* 一屏四宫格（ADR 0007 / spec §8.1）：每块 = 卡片 + 固定标题条 + 块内滚动 body */
      const panel = (key, title, count, body) => h('div', { className: 'fde-card fde-today-panel', key },
        h('div', { className: 'fde-today-panel-head' },
          h('span', { className: 'fde-today-panel-title' }, title),
          h('span', { className: 'fde-today-panel-count' }, String(typeof count === 'number' ? count : 0)),
          h('div', { className: 'fde-spacer' })),
        h('div', { className: 'fde-today-panel-body' }, body));

      const kpi = (key, num, label, tone) => h('div', { className: 'fde-kpi', key },
        h('span', { className: 'fde-kpi-num' + (tone ? ' ' + tone : '') },
          String(typeof num === 'number' ? num : (num || 0))),
        h('span', { className: 'fde-kpi-label' }, label));

      /* 待我处理：错误/加载/空态/分组列表（§2.6 去重与折叠规则不变） */
      const attentionBody = p.briefError
        ? h(ErrorLine, { title: t('briefLoadFail'), text: p.briefError, onRetry: p.onRefreshBrief })
        : (p.briefLoading && !attention.length
          ? h(Loading, { text: '正在读取今日简报…' })
          : (attention.length
            ? h('div', { className: 'fde-list' }, groups.map((g) => {
              const expanded = !!expandedKinds[g.kind];
              const shown = expanded ? g.rows : g.rows.slice(0, 2);
              const hidden = g.rows.length - shown.length;
              return h('div', { key: 'g-' + g.kind, className: 'fde-attn-group' },
                h('div', { className: 'fde-attn-group-head' },
                  h('span', { className: 'fde-attn-kind fde-attn-' + attnTone(g.kind) }, attentionMeta(meta, g.kind).label),
                  h('span', { className: 'fde-hint' }, g.rows.length + ' 条'),
                  h('div', { className: 'fde-spacer' }),
                  hidden > 0
                    ? h(Btn, { small: true, onClick: () => setExpandedKinds((cur) => Object.assign({}, cur, { [g.kind]: true })) }, '展开 ' + hidden + ' 条')
                    : null,
                  expanded && g.rows.length > 2
                    ? h(Btn, { small: true, onClick: () => setExpandedKinds((cur) => Object.assign({}, cur, { [g.kind]: false })) }, '收起')
                    : null),
                shown.map(attentionRow));
            }))
            : h(Empty, {
              title: boardEmpty ? t('demoOnboardTitle') : t('todayEmptyTitle'),
              children: boardEmpty
                ? h('div', { className: 'fde-onboard' },
                  h('div', { className: 'fde-onboard-step' },
                    h('span', { className: 'fde-onboard-no' }, '1'),
                    h('span', null, '新建客户：登记一个值得跟进的客户机会')),
                  h('div', { className: 'fde-onboard-step' },
                    h('span', { className: 'fde-onboard-no' }, '2'),
                    h('span', null, '导入现有项目：扫描 research/ 目录，确认后再写入')),
                  h('div', { className: 'fde-onboard-step' },
                    h('span', { className: 'fde-onboard-no' }, '3'),
                    h('span', null, '想看示例？设置 → 演示数据 → 重新查看示例')))
                : t('todayEmptyBody'),
              actions: boardEmpty
                ? h('div', { className: 'fde-row', style: { marginTop: 8, justifyContent: 'center' } },
                  h(Btn, { small: true, kind: 'primary', onClick: p.onCreate }, '新建客户'),
                  h(Btn, { small: true, onClick: p.onScanNow }, t('scanNow')),
                  h(Btn, { small: true, onClick: p.onOpenSettings }, t('demoStepRestore')))
                : null,
            })));

      return h('div', { className: 'fde-view fde-view-fill fde-today' },
        /* 顶部一行 KPI（固定，不滚动）：统计数字全页只出现这一次（§2.6） */
        h('div', { className: 'fde-today-head' },
          h('div', { className: 'fde-today-greet' },
            h('div', { className: 'fde-today-greet-title' }, greeting()),
            h('div', { className: 'fde-today-greet-sub', title: battleLine },
              battleLine)),
          h('div', { className: 'fde-today-kpis' },
            kpi('active', stats.active, '活跃客户'),
            kpi('attention', attention.length, '待我处理', attention.length ? 'warn' : ''),
            kpi('due', stats.dueToday, '今日到期'),
            kpi('overdue', stats.overdue, '逾期', (stats.overdue || 0) > 0 ? 'alert' : ''))),

        h('div', { className: 'fde-today-grid' },
          panel('attention', t('todayAttention'), attention.length, attentionBody),
          panel('proposals', t('todayProposals'), proposals.length,
            proposals.length
              ? h('div', { className: 'fde-list' }, proposals.map(proposalRow))
              : h(Empty, { mark: '✓', title: '没有待采纳的建议', body: '规则引擎会在读取时生成，采纳或忽略后即消失。' })),
          panel('focus', t('todayFocus'), focus.length,
            focus.length
              ? h('div', { className: 'fde-list' }, focus.map(focusRow))
              : h(Empty, { mark: '◎', title: '暂无焦点客户', body: '看板还是空的。先导入现有项目或新建客户。' })),
          panel('activity', t('todayActivity'), activity.length,
            activity.length
              ? h('div', { className: 'fde-list' }, activity.map(activityRow))
              : h(Empty, { mark: '·', title: '还没有活动记录' }))));
    }

    /* ============================================================
     * 六、看板视图
     * 客户模式：meta.stages 全列（含空列）；任务模式：meta.boardLanes。
     * HTML5 拖拽 + 键盘可达：Tab 聚焦、Enter 开抽屉、Alt+←/→ 换列。
     * 拖拽到受门禁/证据约束的列时，由根组件弹缺项确认（不在此处做）。
     * ============================================================ */
    function BoardView(props) {
      const p = props || {};
      const meta = p.meta;
      const board = p.board || {};
      const mode = p.mode === 'task' ? 'task' : 'customer';
      const [over, setOver] = useState('');
      const [dragging, setDragging] = useState(null);
      const dragRef = useRef(null);
      /* 横滚示能（§2.7）：列总宽超出容器时才提示，滚到末尾取消右侧渐隐 */
      const boardRef = useRef(null);
      const [scrollState, setScrollState] = useState({ can: false, atEnd: true });
      const search = str(p.search).trim().toLowerCase();
      const priority = str(p.priority || 'all');
      const customerId = str(p.customerFilter || '');
      const engagements = asList(board.engagements);
      const items = asList(board.items);

      const matchPriority = (x) => priority === 'all' || str(x.priority || 'normal') === priority;
      const matchSearch = (haystack) => !search || haystack.toLowerCase().indexOf(search) !== -1;
      const matchEngagement = (eng) => matchSearch([
        eng.name, eng.company, eng.shortName, eng.dir, asList(eng.tags).join(' '),
      ].filter(Boolean).join(' ').toLowerCase()) && matchPriority(eng);
      const engById = (id) => engagements.find((e) => e && e.id === id) || null;
      const matchItem = (it) => {
        const eng = it.engagementId ? engById(it.engagementId) : null;
        if (customerId && it.engagementId !== customerId) return false;
        return matchSearch([it.title, eng && (eng.shortName || eng.name), typeLabel(meta, it.type)].filter(Boolean).join(' ').toLowerCase())
          && matchPriority(it);
      };

      const columns = mode === 'customer'
        ? asList(meta && meta.stages).map((s) => ({ key: s.key, label: s.label || s.key, definition: s.definition || '' }))
        : asList(meta && meta.boardLanes).map((l) => ({ key: l.key, label: l.label || l.key, wip: l.wip }));
      const colKeys = columns.map((c) => c.key);

      const measureBoard = useCallback(() => {
        const el = boardRef.current;
        /* 非浏览器环境（单测渲染器）没有真实 DOM：静默跳过 */
        if (!el || typeof el.scrollWidth !== 'number' || typeof el.clientWidth !== 'number') return;
        const can = el.scrollWidth - el.clientWidth > 2;
        const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
        setScrollState((cur) => (cur.can === can && cur.atEnd === atEnd ? cur : { can, atEnd }));
      }, []);
      useEffect(() => {
        measureBoard();
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('resize', measureBoard);
          return () => window.removeEventListener('resize', measureBoard);
        }
        return undefined;
      }, [measureBoard, mode, columns.length]);

      const setDragPayload = (payload) => {
        dragRef.current = payload;
        setDragging(payload);
      };
      const readPayload = (e) => {
        if (!e || !e.dataTransfer || typeof e.dataTransfer.getData !== 'function') return null;
        try {
          const raw = e.dataTransfer.getData('text/plain');
          if (!raw) return null;
          const obj = JSON.parse(raw);
          return obj && obj.kind && obj.id ? obj : null;
        } catch (err) { return null; }
      };
      const beginDrag = (e, payload) => {
        if (e && e.dataTransfer) {
          try {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', JSON.stringify(payload));
          } catch (err) { /* ignore */ }
        }
        setDragPayload(payload);
      };
      const endDrag = () => { dragRef.current = null; setDragging(null); setOver(''); };
      const dropOn = (e, key) => {
        if (e && e.preventDefault) e.preventDefault();
        const payload = readPayload(e) || dragRef.current;
        setOver('');
        setDragPayload(null);
        if (!payload || payload.kind !== (mode === 'customer' ? 'engagement' : 'item')) return;
        if (payload.from === key) return;
        if (payload.kind === 'engagement') p.onMoveEngagement && p.onMoveEngagement(payload.id, key);
        else p.onMoveItem && p.onMoveItem(payload.id, key);
      };

      const keyNav = (e, kind, id, fromKey) => {
        if (!e) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (kind === 'engagement') p.onOpenEngagement && p.onOpenEngagement(id);
          else p.onOpenItem && p.onOpenItem(id);
          return;
        }
        if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          e.preventDefault();
          const idx = colKeys.indexOf(fromKey);
          const next = colKeys[idx + (e.key === 'ArrowRight' ? 1 : -1)];
          if (!next) return;
          if (kind === 'engagement') p.onMoveEngagement && p.onMoveEngagement(id, next, { keyboard: true });
          else p.onMoveItem && p.onMoveItem(id, next, { keyboard: true });
        }
      };

      const engagementCard = (eng) => {
        const next = eng.nextAction || {};
        const stay = daysInStage(eng);
        const attn = eng.attention ? 1 : 0;
        const gate = manualProgress(eng, meta, eng.stage);
        const artCount = engagementArtifactCount(eng);
        const bids = engagementBids(eng);
        const prio = str(eng.priority || 'normal');
        const label = (eng.name || eng.company || eng.dir) + '，' + stageLabel(meta, eng.stage)
          + '，优先级' + priorityLabel(meta, prio) + (next.text ? '，下一步：' + next.text : '');
        const isDragging = dragging && dragging.kind === 'engagement' && dragging.id === eng.id;
        return h('div', {
          key: eng.id,
          className: 'fde-card pad-sm draggable' + (isDragging ? ' dragging' : '') + (eng.paused ? ' paused' : ''),
          role: 'button',
          tabIndex: 0,
          draggable: 'true',
          'aria-label': label,
          title: label,
          onClick: () => p.onOpenEngagement && p.onOpenEngagement(eng.id),
          onKeyDown: (e) => keyNav(e, 'engagement', eng.id, eng.stage),
          onDragStart: (e) => beginDrag(e, { kind: 'engagement', id: eng.id, from: eng.stage }),
          onDragEnd: endDrag,
        },
          h('div', { className: 'fde-card-title-row' },
            Dot({ tone: prio === 'high' ? 'high' : (prio === 'low' ? 'low' : 'normal') }),
            h('div', { className: 'fde-card-name' }, eng.name || eng.company || eng.dir || '—'),
            stay !== null ? h('span', { className: 'fde-card-days', title: '停留天数' }, stay + '天') : null),
          h('div', { className: 'fde-card-next' }, next.text || t('boardNoNext')),
          h('div', { className: 'fde-card-meta' },
            next.due
              ? Chip({ tone: isOverdue(next.due) ? 'danger' : 'muted', children: fmtDay(next.due) })
              : null,
            eng.paused ? Chip({ tone: 'warn', children: t('drawerPaused') }) : null,
            attn ? h('span', { className: 'fde-dotline', title: '有注意力' }, Dot({ tone: 'alert' }), attn) : null,
            gate
              ? h('span', {
                className: 'fde-dotline',
                title: '当前阶段人工门禁 ' + gate.pass + '/' + gate.total,
              }, Dot({ tone: gate.pass >= gate.total ? 'ok' : 'warn' }), gate.pass + '/' + gate.total)
              : null,
            artCount !== null ? h('span', { className: 'fde-dotline', title: '工件数' }, '工 ' + artCount) : null,
            (bids.available && bids.total > 0)
              ? h('span', {
                className: 'fde-dotline',
                title: bidCardBadgeTitle(bids),
              }, Chip({ tone: 'accent', children: '招采 ' + bids.total }))
              : null),
          asList(eng.tags).length
            ? h('div', { className: 'fde-card-tags' }, asList(eng.tags).slice(0, 3).map((tg) => h('span', { key: 'tag-' + tg, className: 'fde-chip muted' }, tg)))
            : null);
      };

      const itemCard = (it) => {
        const eng = it.engagementId ? engById(it.engagementId) : null;
        const prio = str(it.priority || 'normal');
        const lane = laneOf(meta, it.stage);
        const label = it.title + '，' + (eng ? eng.shortName || eng.name : t('drawerItemIndependent'))
          + '，优先级' + priorityLabel(meta, prio);
        const isDragging = dragging && dragging.kind === 'item' && dragging.id === it.id;
        const reports = asList(it.reports);
        return h('div', {
          key: it.id,
          className: 'fde-card pad-sm draggable' + (isDragging ? ' dragging' : ''),
          role: 'button',
          tabIndex: 0,
          draggable: 'true',
          'aria-label': label,
          title: label,
          onClick: () => p.onOpenItem && p.onOpenItem(it.id),
          onKeyDown: (e) => keyNav(e, 'item', it.id, it.stage),
          onDragStart: (e) => beginDrag(e, { kind: 'item', id: it.id, from: it.stage }),
          onDragEnd: endDrag,
        },
          h('div', { className: 'fde-card-title-row' },
            Dot({ tone: prio === 'high' ? 'high' : (prio === 'low' ? 'low' : 'normal') }),
            h('div', { className: 'fde-card-name' }, it.title || '—')),
          h('div', { className: 'fde-card-meta' },
            Chip({ tone: 'muted', children: typeLabel(meta, it.type) }),
            eng ? Chip({ tone: '', children: eng.shortName || eng.name }) : null,
            it.due ? Chip({ tone: isOverdue(it.due) ? 'danger' : 'muted', children: fmtDay(it.due) }) : null,
            it.attention ? h('span', { className: 'fde-dotline', title: '有注意力' }, Dot({ tone: 'alert' })) : null,
            reports.length ? h('span', { className: 'fde-dotline', title: '回报数' }, '回报 ' + reports.length) : null),
          lane && lane.definition ? h('div', { className: 'fde-hint', style: { marginTop: 6 } }, lane.definition) : null);
      };

      const renderColumn = (col) => {
        const cards = mode === 'customer'
          ? engagements.filter((e) => e && e.stage === col.key && matchEngagement(e))
          : items.filter((it) => it && it.stage === col.key && matchItem(it));
        const wipLimit = mode === 'task'
          ? (col.wip !== null && col.wip !== undefined
            ? col.wip
            : (board.settings && board.settings.wipLimits ? board.settings.wipLimits[col.key] : null))
          : null;
        const overWip = wipLimit !== null && wipLimit !== undefined && cards.length > Number(wipLimit);
        return h('div', {
          key: col.key,
          className: 'fde-col' + (over === col.key ? ' over' : '') + (overWip ? ' over-wip' : ''),
          role: 'list',
          'aria-label': col.label + '，' + cards.length + ' 项',
          onDragOver: (e) => { if (e && e.preventDefault) e.preventDefault(); if (e && e.dataTransfer) { try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* ignore */ } } if (over !== col.key) setOver(col.key); },
          onDragLeave: () => setOver(''),
          onDrop: (e) => dropOn(e, col.key),
        },
          h('div', { className: 'fde-col-head' },
            h('span', { className: 'fde-col-title', title: col.definition || '' }, col.label),
            h('span', { className: 'fde-col-count' }, String(cards.length)),
            wipLimit !== null && wipLimit !== undefined
              ? h('span', { className: 'fde-col-wip', title: 'WIP 上限 ' + wipLimit }, 'WIP ' + cards.length + '/' + wipLimit)
              : null),
          h('div', { className: 'fde-col-body' },
            cards.length
              ? cards.map(mode === 'customer' ? engagementCard : itemCard)
              : h('div', { className: 'fde-col-empty' }, '（空）')));
      };

      const emptyBoard = mode === 'customer' && engagements.length === 0;
      return h('div', { className: 'fde-view fde-view-fill' },
        h('div', { className: 'fde-toolbar' },
          h('div', { className: 'fde-search' },
            h('span', { className: 'fde-search-icon', 'aria-hidden': 'true' }, '⌕'),
            h('input', {
              className: 'fde-input', type: 'search', value: p.search || '',
              placeholder: t('boardSearchPh'), 'aria-label': t('search'),
              onChange: (e) => p.onSearch && p.onSearch(e.target.value),
            })),
          h('select', {
            className: 'fde-select', style: { height: 30, fontSize: 13 }, value: priority,
            'aria-label': t('boardPriority'),
            onChange: (e) => p.onPriority && p.onPriority(e.target.value),
          },
            [{ value: 'all', label: t('all') + '优先级' }].concat(
              asList(meta && meta.priorities).map((x) => ({ value: x.key, label: x.label }))
            ).map((o) => h('option', { key: o.value, value: o.value }, o.label))),
          mode === 'task'
            ? h('select', {
              className: 'fde-select', style: { height: 30, fontSize: 13, maxWidth: 180 }, value: customerId,
              'aria-label': t('boardCustomer'),
              onChange: (e) => p.onCustomerFilter && p.onCustomerFilter(e.target.value),
            },
              [{ value: '', label: t('all') + '客户' }].concat(
                engagements.map((e) => ({ value: e.id, label: e.shortName || e.name || e.dir || e.id }))
              ).map((o) => h('option', { key: o.value, value: o.value }, o.label)))
            : null,
          h('div', { className: 'fde-spacer' }),
          mode === 'task' ? h(Btn, { small: true, kind: 'primary', onClick: p.onCreateItem }, '新建任务') : null),
        h('div', { className: 'fde-row', style: { justifyContent: 'space-between' } },
          h('span', { className: 'fde-hint' }, t('boardDragHint')),
          h(KeyHint, {})),
        emptyBoard
          ? h(Empty, {
            title: t('boardEmpty'),
            actions: h('div', { className: 'fde-row', style: { justifyContent: 'center', marginTop: 8 } },
              h(Btn, { small: true, kind: 'primary', onClick: p.onScanNow }, t('scanNow')),
              h(Btn, { small: true, onClick: p.onOpenCustomers }, t('customersTitle'))),
          })
          : h('div', { className: 'fde-board-wrap' },
            scrollState.can
              ? h('div', { className: 'fde-board-hint' },
                '← 横向滚动查看全部 ' + columns.length + ' 个' + (mode === 'customer' ? '阶段' : '泳道'))
              : null,
            h('div', {
              className: 'fde-board' + (scrollState.can && !scrollState.atEnd ? ' mask-right' : ''),
              role: 'group',
              'aria-label': t('board'),
              ref: boardRef,
              onScroll: measureBoard,
            }, columns.map(renderColumn))));
    }

    /* ============================================================
     * 七、客户视图
     * 表格 + 搜索/阶段/优先级筛选；「导入现有项目」两段式：
     * ①扫描候选（不写盘）→ ②人工勾选确认后 apply 导入。
     * ============================================================ */
    function normalizeCandidates(raw) {
      return asList(raw).map((c, i) => {
        const o = c && typeof c === 'object' ? c : {};
        const ev = o.evidence;
        let evidence = [];
        if (Array.isArray(ev)) {
          evidence = ev.map((x) => str(typeof x === 'string' ? x : (x && (x.label || x.text || x.key || x.dir)))).filter(Boolean);
        } else if (ev && typeof ev === 'object') {
          evidence = Object.keys(ev).filter((k) => ev[k]).map((k) => k + '：' + str(ev[k]));
        }
        return {
          key: str(pick(o.dir, 'cand-' + i)),
          dir: str(pick(o.dir, o.name)),
          title: str(pick(o.title, o.company, o.dir)),
          kind: str(o.kind || ''),
          stage: str(pick(o.suggestedStage, o.stage)),
          confidence: str(o.confidence || ''),
          adopted: !!o.adopted,
          already: !!(o.alreadyImported || o.engagementId),
          importable: o.importable !== false,
          engagementId: str(o.engagementId || ''),
          mdCount: typeof o.mdCount === 'number' ? o.mdCount : null,
          mtime: str(pick(o.lastModifiedAt, o.mtime)),
          evidence,
          reason: str(pick(o.reason, o.hint, '')),
        };
      }).filter((c) => c.dir);
    }

    function CustomersView(props) {
      const p = props || {};
      const meta = p.meta;
      const board = p.board || {};
      const [search, setSearch] = useState('');
      const [stageFilter, setStageFilter] = useState('all');
      const [prioFilter, setPrioFilter] = useState('all');
      const [showAdopt, setShowAdopt] = useState(false);
      const [scanning, setScanning] = useState(false);
      const [candidates, setCandidates] = useState(null);
      const [selected, setSelected] = useState({});
      const [adoptErr, setAdoptErr] = useState('');
      const [applying, setApplying] = useState(false);
      const [adoptMsg, setAdoptMsg] = useState('');
      const alive = useRef(true);
      const scanToken = p.scanToken || 0;
      const scanRef = useRef(null);

      useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

      const runScan = useCallback(async () => {
        setScanning(true); setAdoptErr(''); setAdoptMsg(''); setShowAdopt(true);
        const r = await fdePost('/adopt', { action: 'scan' });
        if (!alive.current) return;
        setScanning(false);
        if (!r || r.ok === false) { setAdoptErr((r && r.reason) || '扫描失败'); setCandidates([]); return; }
        setCandidates(normalizeCandidates(r.candidates || r.items || r.list || []));
        setSelected({});
      }, []);

      /* 今日页「扫描现有项目」也走这里：scanToken 递增触发 */
      useEffect(() => {
        if (!scanToken) return;
        if (scanRef.current === scanToken) return;
        scanRef.current = scanToken;
        runScan();
      }, [scanToken, runScan]);

      const toggle = (dir) => setSelected((cur) => {
        const next = Object.assign({}, cur);
        if (next[dir]) delete next[dir]; else next[dir] = true;
        return next;
      });

      const applyImport = async () => {
        const dirs = Object.keys(selected).filter((d) => selected[d]);
        if (!dirs.length) return;
        setApplying(true); setAdoptErr(''); setAdoptMsg('');
        const r = await fdePost('/adopt', { action: 'apply', dirs });
        if (!alive.current) return;
        setApplying(false);
        if (!r || r.ok === false) { setAdoptErr((r && r.reason) || '导入失败'); return; }
        setAdoptMsg('已导入 ' + dirs.length + ' 个目录');
        if (p.onRefresh) await p.onRefresh();
        await runScan();
      };

      const engs = asList(board.engagements);
      const q = str(search).trim().toLowerCase();
      const rows = engs.filter((e) => {
        if (!e) return false;
        const hay = [e.name, e.company, e.shortName, e.dir, asList(e.tags).join(' ')].filter(Boolean).join(' ').toLowerCase();
        if (q && hay.indexOf(q) === -1) return false;
        if (stageFilter !== 'all' && e.stage !== stageFilter) return false;
        if (prioFilter !== 'all' && str(e.priority || 'normal') !== prioFilter) return false;
        return true;
      });

      const adoptPanel = () => {
        const list = candidates || [];
        const selectable = list.filter((c) => !c.already && c.importable);
        const chosen = selectable.filter((c) => selected[c.dir]).length;
        return h('div', { className: 'fde-card', style: { marginTop: 12 } },
          h('div', { className: 'fde-card-title' },
            h('span', null, t('customersAdopt')),
            h('div', { className: 'fde-spacer' }),
            h(Btn, { small: true, onClick: runScan, disabled: scanning || applying, busy: scanning }, scanning ? t('customersScanning') : '重新扫描'),
            h(Btn, { small: true, onClick: () => setShowAdopt(false) }, t('close'))),
          h('div', { className: 'fde-hint', style: { marginBottom: 8 } }, t('customersAdoptHint')),
          adoptErr ? h(MsgLine, { kind: 'err', text: adoptErr }) : null,
          adoptMsg ? h(MsgLine, { kind: 'ok', text: adoptMsg }) : null,
          scanning
            ? h(Loading, { text: t('customersScanning') })
            : (list.length === 0
              ? h(Empty, { mark: '⌕', title: t('customersScanEmpty') })
              : h('div', { className: 'fde-adopt' },
                list.map((c) => {
                  const stageTxt = c.stage ? stageLabel(meta, c.stage) : '';
                  return h('label', { key: c.key, className: 'fde-cand' },
                    h('input', {
                      type: 'checkbox',
                      checked: !!selected[c.dir],
                      disabled: c.already || !c.importable,
                      'aria-label': '导入 ' + c.title,
                      onChange: () => toggle(c.dir),
                    }),
                    h('div', { className: 'fde-cand-main' },
                      h('div', { className: 'fde-cand-title' }, c.title || c.dir),
                      h('div', { className: 'fde-row tight' },
                        c.kind ? Chip({ tone: 'muted', children: c.kind }) : null,
                        c.adopted ? Chip({ tone: 'muted', children: '已建档' }) : null,
                        c.already ? Chip({ tone: 'ok', children: t('customersAlready') }) : null,
                        !c.importable ? Chip({ tone: 'warn', children: '目录名不可用' }) : null,
                        stageTxt ? Chip({ tone: 'on', children: t('customersStage') + '：' + stageTxt }) : null,
                        c.confidence ? Chip({ tone: 'muted', children: t('customersConfidence') + '：' + c.confidence }) : null,
                        c.mdCount !== null ? h('span', { className: 'fde-hint' }, c.mdCount + ' 个 md') : null,
                        c.mtime ? h('span', { className: 'fde-hint' }, '最近 ' + relTime(c.mtime)) : null),
                      h('div', { className: 'fde-code' }, c.dir),
                      c.evidence.length
                        ? h('div', { className: 'fde-hint' }, t('customersEvidence') + '：' + c.evidence.slice(0, 3).join('；'))
                        : null,
                      c.reason ? h('div', { className: 'fde-hint' }, c.reason) : null));
                }),
                h('div', { className: 'fde-row', style: { marginTop: 4 } },
                  h(Btn, {
                    small: true, kind: 'primary', disabled: !chosen || applying, busy: applying,
                    onClick: applyImport,
                  }, applying ? t('customersImporting') : t('customersImport') + (chosen ? '（' + chosen + '）' : '')),
                  h('span', { className: 'fde-hint' }, '只写 research/.fde/board.json，不改动客户目录。')))));
      };

      return h('div', { className: 'fde-view' },
        h('div', { className: 'fde-toolbar' },
          h('div', { className: 'fde-search' },
            h('span', { className: 'fde-search-icon', 'aria-hidden': 'true' }, '⌕'),
            h('input', {
              className: 'fde-input', type: 'search', value: search,
              placeholder: t('customersSearchPh'), 'aria-label': t('search'),
              onChange: (e) => setSearch(e.target.value),
            })),
          h(Select, {
            value: stageFilter, ariaLabel: t('customersStage'),
            options: [{ value: 'all', label: t('all') + '阶段' }].concat(
              asList(meta && meta.stages).map((s) => ({ value: s.key, label: s.label || s.key }))
            ),
            onChange: (e) => setStageFilter(e.target.value),
          }),
          h(Select, {
            value: prioFilter, ariaLabel: t('customersPriority'),
            options: [{ value: 'all', label: t('all') + '优先级' }].concat(
              asList(meta && meta.priorities).map((x) => ({ value: x.key, label: x.label }))
            ),
            onChange: (e) => setPrioFilter(e.target.value),
          }),
          h('div', { className: 'fde-spacer' }),
          h(Btn, { small: true, kind: 'primary', onClick: p.onCreate }, '新建客户'),
          h(Btn, { small: true, onClick: () => { if (candidates === null) runScan(); else setShowAdopt((v) => !v); }, busy: scanning }, t('customersAdopt'))),
        showAdopt ? adoptPanel() : null,
        rows.length === 0
          ? h(Empty, {
            title: engs.length ? t('boardNoResult') : t('customersEmpty'),
            mark: '◎',
            actions: h('div', { className: 'fde-row', style: { justifyContent: 'center', marginTop: 8 } },
              h(Btn, { small: true, kind: 'primary', onClick: p.onCreate }, '新建客户'),
              h(Btn, { small: true, onClick: () => { if (candidates === null) runScan(); else setShowAdopt(true); } }, t('customersAdopt')),
              p.onOpenSettings ? h(Btn, { small: true, onClick: p.onOpenSettings }, t('demoStepRestore')) : null),
          })
          : h('div', { className: 'fde-table-wrap' },
            h('div', { className: 'fde-row', style: { padding: '8px 12px', borderBottom: '0.5px solid var(--fde-border)' } },
              h('span', { className: 'fde-section-title' }, t('customersTitle')),
              h('span', { className: 'fde-hint' }, rows.length + ' / ' + engs.length + ' ' + t('customersCount'))),
            h('div', { style: { overflowX: 'auto' } },
              h('table', { className: 'fde-table' },
                h('thead', null,
                  h('tr', null,
                    h('th', null, t('customersTitle')),
                    h('th', null, t('customersStage')),
                    h('th', null, t('customersPriority')),
                    h('th', null, t('customersNext')),
                    h('th', null, t('customersDue')),
                    h('th', null, t('customersStay')),
                    h('th', null, t('customersAttention')))),
                h('tbody', null, rows.map((e) => {
                  const next = e.nextAction || {};
                  const stay = daysInStage(e);
                  const attn = e.attention ? str(pick(e.attention.kind, '待处理')) : '';
                  const archived = meta && meta.terminalStages && meta.terminalStages.indexOf(e.stage) !== -1;
                  return h('tr', {
                    key: e.id,
                    className: archived ? 'archived' : '',
                    tabIndex: 0,
                    role: 'button',
                    onClick: () => p.onOpenEngagement && p.onOpenEngagement(e.id),
                    onKeyDown: (ev) => { if (ev && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); p.onOpenEngagement && p.onOpenEngagement(e.id); } },
                  },
                    h('td', { className: 'fde-cell-name' },
                      h('div', null, e.name || e.company || e.dir || '—'),
                      e.dir && e.dir !== e.name ? h('div', { className: 'fde-code' }, e.dir) : null),
                    h('td', null, Chip({ tone: archived ? 'muted' : 'on', children: stageLabel(meta, e.stage) })),
                    h('td', null, PriorityTag({ value: e.priority, label: priorityLabel(meta, e.priority), meta })),
                    h('td', { className: 'fde-cell-now' }, next.text || h('span', { className: 'fde-dim' }, t('boardNoNext'))),
                    h('td', { className: 'fde-cell-num' }, next.due
                      ? h('span', { className: isOverdue(next.due) ? 'fde-warn' : '' }, fmtDay(next.due))
                      : h('span', { className: 'fde-dim' }, '—')),
                    h('td', { className: 'fde-cell-num' }, stay !== null ? stay + ' ' + t('customersDays') : '—'),
                    h('td', null, attn
                      ? h('span', { className: 'fde-attn-cell' }, Dot({ tone: 'alert' }), attentionMeta(meta, attn).label)
                      : h('span', { className: 'fde-attn-cell quiet' }, '—')));
                }))))));
    }

    /* ============================================================
     * 八、资料视图（v1.7 重构；ADR 0008）
     * 左列：可搜索/筛选的关键资料（默认「最近资料」，可切「按客户」）；
     * 右列：内嵌预览（md/txt/PDF/图片/网页快照/Word/Excel/PPT）。
     * 原始素材（raw/ 与 html/json/xml/tsv/log）默认折叠，带计数可开。
     * 预览复用宿主能力：同源鉴权路由 /api/file + remote.officeToPdf；
     * 不新增宿主路由、不引入依赖、不写任何状态。
     * ============================================================ */
    const FILE_GROUP_ORDER = ['00-项目档案.md', 'raw', 'research', 'meeting', 'proposal', 'pilot', 'delivery', 'adoption', 'internal', 'exports'];

    function groupFiles(files) {
      const groups = {};
      asList(files).forEach((f) => {
        const rel = str(f && f.rel);
        if (!rel) return;
        const seg = rel.indexOf('/') === -1 ? '根目录' : rel.split('/')[0];
        if (!groups[seg]) groups[seg] = [];
        groups[seg].push(f);
      });
      const order = Object.keys(groups).sort((a, b) => {
        const ia = FILE_GROUP_ORDER.indexOf(a);
        const ib = FILE_GROUP_ORDER.indexOf(b);
        if (a === '根目录') return -1;
        if (b === '根目录') return 1;
        if (ia === -1 && ib === -1) return a < b ? -1 : 1;
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
      });
      return order.map((k) => ({ key: k, files: groups[k] }));
    }

    /* ---- 分类与预览工具（ADR 0008） ---- */
    const MAT_RAW_EXTS = ['html', 'htm', 'json', 'jsonl', 'xml', 'tsv', 'log', 'warc', 'eml', 'sitemap'];
    const MAT_TEXT_EXTS = ['md', 'markdown', 'txt', 'text', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'yaml', 'yml', 'html', 'htm', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'less', 'py', 'sh', 'bash', 'zsh', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sql', 'toml', 'ini', 'cfg', 'conf', 'env', 'gitignore', 'log', 'diff', 'patch', 'tex'];
    const MAT_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'];
    const MAT_OFFICE_EXTS = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf'];
    const MAT_RAW_PATH_RE = /(^|\/)raw\//i;
    /* 资料页 UI 记忆：切去会话看 DSH 原生预览再返回时，恢复上次的筛选/分组；
       只存内存（非事实源），刷新页面即重置。 */
    const MAT_UI_MEM = { mode: 'recent', q: '', cat: 'all', showRaw: false, sort: 'recent', expanded: {}, listWidth: 380 };
    /* 主视图记忆：切去会话看 DSH 原生预览再回来时，仍停在离开前的页签（如「资料」） */
    const FDE_VIEW_MEM = { view: 'today' };

    function matExt(rel) {
      const name = str(rel).split('/').pop();
      const i = name.lastIndexOf('.');
      return i > 0 ? name.slice(i + 1).toLowerCase() : '';
    }
    function matName(rel) {
      const parts = str(rel).split('/');
      return parts[parts.length - 1] || str(rel);
    }
    function matDirLabel(rel) {
      const parts = str(rel).split('/');
      return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    }
    function matIsRaw(rel) {
      const low = str(rel).toLowerCase();
      if (MAT_RAW_PATH_RE.test(low)) return true;
      return MAT_RAW_EXTS.indexOf(matExt(low)) >= 0;
    }
    function matPreviewKind(rel) {
      const ext = matExt(rel);
      if (ext === 'md' || ext === 'markdown') return 'md';
      if (ext === 'pdf') return 'pdf';
      if (MAT_OFFICE_EXTS.indexOf(ext) >= 0) return 'office';
      if (MAT_IMAGE_EXTS.indexOf(ext) >= 0) return 'image';
      if (ext === 'html' || ext === 'htm') return 'html';
      if (MAT_TEXT_EXTS.indexOf(ext) >= 0) return 'text';
      return 'binary';
    }
    function matCat(rel) {
      const k = matPreviewKind(rel);
      if (k === 'md' || k === 'text') return 'doc';
      if (k === 'pdf') return 'pdf';
      if (k === 'office') return 'office';
      if (k === 'image') return 'image';
      if (k === 'html') return 'web';
      return 'other';
    }
    function matBytes(n) {
      const v = Number(n) || 0;
      if (v <= 0) return '';
      if (v < 1024) return v + ' B';
      if (v < 1024 * 1024) return Math.max(1, Math.round(v / 1024)) + ' KB';
      return (v / 1024 / 1024).toFixed(v < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
    }
    function matAbsJoin(base, rel) {
      const b = str(base).replace(/\/+$/, '');
      const r = str(rel).replace(/^\/+/, '');
      return b && r ? b + '/' + r : (b || r);
    }
    function matFileUrl(abs) {
      return '/api/file?path=' + encodeURIComponent(str(abs));
    }
    /* md 内相对图片：按文档所在目录解析（/api/file 需要绝对路径） */
    function matResolveAsset(docAbs, url) {
      const u = str(url).trim();
      if (!u || /^(?:https?:|data:|blob:|mailto:|#)/i.test(u)) return u;
      const clean = u.split('#')[0].split('?')[0].replace(/^\.\//, '');
      const dir = str(docAbs).replace(/\/+[^/]*$/, '');
      const abs = dir ? dir + '/' + clean : clean;
      return matFileUrl(abs);
    }

    /* ---- 轻量 Markdown → React 节点（无 HTML 注入，无依赖） ---- */
    function mdInline(text, docAbs) {
      const src = String(text == null ? '' : text);
      if (!src) return null;
      const out = [];
      const re = /(!\[[^\]]*\]\(([^)\s]+)[^)]*\)|\[([^\]]+)\]\(([^)\s]+)[^)]*\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*?)\*)/g;
      let last = 0;
      let m;
      let k = 0;
      while ((m = re.exec(src)) !== null) {
        if (m.index > last) out.push(src.slice(last, m.index));
        if (m[2] != null && m[1].charAt(0) === '!') {
          const alt = m[1].replace(/^!\[/, '').replace(/\]\(.*$/, '');
          const url = matResolveAsset(docAbs, m[2]);
          out.push(h('img', { key: 'mdi' + (k++), className: 'fde-md-img', src: url, alt, loading: 'lazy' }));
        } else if (m[3] != null && m[4] != null) {
          const href = /^(?:https?:|mailto:|#)/i.test(m[4]) ? m[4] : matResolveAsset(docAbs, m[4]);
          out.push(h('a', { key: 'mda' + (k++), className: 'fde-md-link', href, target: '_blank', rel: 'noreferrer noopener' }, m[3]));
        } else if (m[5] != null) {
          out.push(h('code', { key: 'mdc' + (k++), className: 'fde-md-code' }, m[5]));
        } else if (m[6] != null) {
          out.push(h('strong', { key: 'mdb' + (k++) }, m[6]));
        } else if (m[7] != null) {
          out.push(h('strong', { key: 'mdb2' + (k++) }, m[7]));
        } else if (m[8]) {
          out.push(h('em', { key: 'mdi2' + (k++) }, m[8]));
        }
        last = re.lastIndex;
      }
      if (last < src.length) out.push(src.slice(last));
      return out;
    }

    function renderMarkdown(text, docAbs) {
      const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
      const blocks = [];
      let i = 0;
      let key = 0;
      const push = (el) => { blocks.push(h('div', { key: 'mdb' + (key++), className: 'fde-md-block' }, el)); };
      let buf = [];
      const flush = () => {
        if (!buf.length) return;
        const para = buf.join(' ').trim();
        buf = [];
        if (para) push(h('p', { className: 'fde-md-p' }, mdInline(para, docAbs)));
      };
      /* YAML frontmatter → 键值表 */
      if (lines[0] === '---') {
        let j = 1;
        while (j < lines.length && lines[j] !== '---' && lines[j] !== '...') j++;
        if (j < lines.length) {
          const kv = [];
          for (let x = 1; x < j; x++) {
            const mm = lines[x].match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
            if (mm) kv.push([mm[1], mm[2]]);
          }
          if (kv.length) {
            push(h('div', { className: 'fde-md-fm' }, kv.map(([k2, v2]) =>
              h('div', { key: 'fm' + k2, className: 'fde-md-fm-row' },
                h('span', { className: 'fde-md-fm-k' }, k2),
                h('span', { className: 'fde-md-fm-v' }, v2)))));
          }
          i = j + 1;
        }
      }
      while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) { flush(); i++; continue; }
        const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/);
        if (fence) {
          flush();
          const mark = fence[1][0];
          const code = [];
          i++;
          while (i < lines.length && !new RegExp('^\\s*' + mark + '{' + fence[1].length + ',}\\s*$').test(lines[i])) { code.push(lines[i]); i++; }
          i++;
          push(h('pre', { className: 'fde-md-pre' }, h('code', null, code.join('\n'))));
          continue;
        }
        const hm = line.match(/^(#{1,6})\s+(.*)$/);
        if (hm) {
          flush();
          const lvl = Math.min(6, hm[1].length);
          push(h('h' + Math.max(3, lvl), { className: 'fde-md-h fde-md-h' + lvl }, mdInline(hm[2], docAbs)));
          i++;
          continue;
        }
        if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { flush(); push(h('hr', { className: 'fde-md-hr' })); i++; continue; }
        if (/^\s*>\s?/.test(line)) {
          flush();
          const quote = [];
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
          push(h('blockquote', { className: 'fde-md-quote' }, quote.map((t2, idx) => h('p', { key: 'q' + idx }, mdInline(t2, docAbs)))));
          continue;
        }
        if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
          flush();
          const cellsOf = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
          const head = cellsOf(line);
          i += 2;
          const rows = [];
          while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(cellsOf(lines[i])); i++; }
          push(h('div', { className: 'fde-md-table-wrap' }, h('table', { className: 'fde-md-table' },
            h('thead', null, h('tr', null, head.map((c, idx) => h('th', { key: 'th' + idx }, mdInline(c, docAbs))))),
            h('tbody', null, rows.map((r, ri) => h('tr', { key: 'tr' + ri }, r.map((c, ci) => h('td', { key: 'td' + ci }, mdInline(c, docAbs)))))))));
          continue;
        }
        if (/^\s*([-*+])\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
          flush();
          const ordered = /^\s*\d+[.)]\s+/.test(line);
          const items = [];
          while (i < lines.length && (/^\s*([-*+])\s+/.test(lines[i]) || /^\s*\d+[.)]\s+/.test(lines[i]))) {
            items.push(lines[i].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''));
            i++;
          }
          push(h(ordered ? 'ol' : 'ul', { className: 'fde-md-list' }, items.map((it, idx) => {
            const task = it.match(/^\[([ xX])\]\s*(.*)$/);
            if (task) {
              return h('li', { key: 'li' + idx, className: 'fde-md-task' },
                h('input', { type: 'checkbox', checked: task[1].toLowerCase() === 'x', readOnly: true, tabIndex: -1 }),
                h('span', null, mdInline(task[2], docAbs)));
            }
            return h('li', { key: 'li' + idx }, mdInline(it, docAbs));
          })));
          continue;
        }
        buf.push(line.trim());
        i++;
      }
      flush();
      return blocks;
    }

    /* ---- 溢出菜单（行内次要操作） ---- */
    function MatMenu(props) {
      const p = props || {};
      const [open, setOpen] = useState(false);
      const rootRef = useRef(null);
      useEffect(() => {
        if (!open) return undefined;
        const onDoc = (e) => { const el = rootRef.current; if (el && e && e.target && el.contains(e.target)) return; setOpen(false); };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
      }, [open]);
      return h('span', { className: 'fde-mat-menu-wrap', ref: rootRef },
        h('button', {
          type: 'button', className: 'fde-iconbtn fde-mat-more', 'aria-label': t('matMore'), title: t('matMore'),
          onClick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); setOpen((v) => !v); },
        }, '⋯'),
        open ? h('div', { className: 'fde-mat-menu', role: 'menu' }, asList(p.items).map((it, idx) =>
          h('button', {
            key: 'mi' + idx, type: 'button', role: 'menuitem', className: 'fde-mat-menu-item',
            onClick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); setOpen(false); if (it.onSelect) it.onSelect(); },
          }, it.label))) : null);
    }

    /* ---- 预览面板 ---- */
    function FilePreview(props) {
      const p = props || {};
      const file = p.file || null;
      const kind = file ? matPreviewKind(file.rel) : '';
      const [state, setState] = useState({ status: 'empty' });
      const [htmlMode, setHtmlMode] = useState('snapshot');
      const [reload, setReload] = useState(0);
      const alive = useRef(true);
      const urlRef = useRef('');
      const officeTried = useRef(0);
      useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
      useEffect(() => () => {
        try { if (urlRef.current) URL.revokeObjectURL(urlRef.current); } catch (e) { /* ignore */ }
        urlRef.current = '';
      }, []);

      useEffect(() => {
        const abs = file && file.abs ? String(file.abs) : '';
        const cleanup = () => { try { if (urlRef.current) URL.revokeObjectURL(urlRef.current); } catch (e) { /* ignore */ } urlRef.current = ''; };
        if (!abs) { setState({ status: 'empty' }); return cleanup; }
        if (kind === 'binary') { setState({ status: 'binary' }); return cleanup; }
        if (kind === 'image') { setState({ status: 'ready-image', src: matFileUrl(abs) }); return cleanup; }
        let cancelled = false;
        const fail = (e) => {
          if (cancelled) return;
          setState({ status: 'error', err: String((e && (e.message || e.reason)) || e || '未知原因') });
        };
        const makePdf = async (blob) => {
          if (cancelled) return;
          cleanup();
          const url = URL.createObjectURL(blob);
          urlRef.current = url;
          setState({ status: 'ready-pdf', src: url });
        };
        setState({ status: 'loading' });
        (async () => {
          try {
            if (kind === 'office') {
              officeTried.current = 0;
              if (!p.officeToPdf) throw new Error(t('matOfficeNoSession'));
              setState({ status: 'loading', note: t('matOfficeLoading') });
              let blob;
              try { blob = await p.officeToPdf(abs); }
              catch (e1) {
                /* 冷启动/并发排队时第一次可能失败：等一拍再重试一次，仍失败才报错 */
                officeTried.current = 1;
                await new Promise((r2) => setTimeout(r2, 900));
                blob = await p.officeToPdf(abs);
              }
              await makePdf(blob);
              return;
            }
            const r = await readFileAbs(abs, kind === 'pdf' ? 'blob' : 'text');
            if (!r || r.ok === false) throw new Error((r && r.reason) || 'HTTP ?');
            if (kind === 'pdf') { await makePdf(r.blob); return; }
            const text = String(r.text || '');
            if (cancelled) return;
            const truncated = text.length > 400000;
            setState({ status: 'ready-text', text: truncated ? text.slice(0, 400000) : text, note: truncated ? t('matTextTruncated') : '' });
          } catch (e) { fail(e); }
        })();
        return () => { cancelled = true; cleanup(); };
      }, [file && file.abs, reload, kind]);

      useEffect(() => {
        if (!p.full) return undefined;
        const onKey = (e) => { if (e && e.key === 'Escape') { if (e.preventDefault) e.preventDefault(); if (p.onToggleFull) p.onToggleFull(false); } };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [p.full]);

      const abs = file && file.abs ? String(file.abs) : '';
      const head = h('div', { className: 'fde-pv-head' },
        p.onBack ? h('button', {
          type: 'button', className: 'fde-iconbtn fde-pv-back', title: t('matBackList'), 'aria-label': t('matBackList'),
          onClick: p.onBack,
        }, '‹') : null,
        h('div', { className: 'fde-pv-head-main' },
          h('div', { className: 'fde-pv-title', title: file ? file.rel : '' }, file ? matName(file.rel) : t('matPick')),
          file ? h('div', { className: 'fde-pv-meta' },
            h('span', { className: 'fde-pv-path', title: abs }, file.rel),
            file.engName ? Chip({ tone: 'muted', children: file.engName }) : null,
            file.raw ? Chip({ tone: 'muted', children: t('matRawBadge') }) : null,
            h('span', { className: 'fde-hint' }, [matBytes(file.size), file.mtime ? relTime(file.mtime) : ''].filter(Boolean).join(' · '))) : null),
        h('div', { className: 'fde-pv-actions' },
          file && kind === 'md' && p.onExport ? h(Btn, { small: true, onClick: () => p.onExport(file) }, t('matExport')) : null,
          file && p.onQa && (file.pdfRel || /\.pdf$/i.test(file.rel)) ? h(Btn, { small: true, onClick: () => p.onQa(file) }, t('matQa')) : null,
          file ? h(Btn, { small: true, onClick: () => p.onOpenPath(abs, 'open', file.rel, 'file') }, t('matSystemOpen')) : null,
          file ? h(Btn, { small: true, onClick: () => setReload((v) => v + 1) }, t('matReloadOne')) : null,
          h(Btn, { small: true, onClick: () => { if (p.onToggleFull) p.onToggleFull(!p.full); } }, p.full ? t('matExitFull') : t('matFull')),
          p.onClose ? h('button', { type: 'button', className: 'fde-iconbtn', title: t('close'), 'aria-label': t('close'), onClick: p.onClose }, '×') : null));

      let body = null;
      if (!file) {
        body = h(Empty, { mark: '▤', title: t('matPick'), body: h('div', { className: 'fde-hint' }, t('matPickHint')) });
      } else if (state.status === 'loading') {
        body = h(Loading, { text: state.note || t('loading') });
      } else if (state.status === 'error') {
        body = h(ErrorLine, {
          title: t('matLoadFail'), text: state.err,
          onRetry: () => setReload((v) => v + 1),
        });
      } else if (state.status === 'binary') {
        body = h(Empty, {
          mark: '▦', title: t('matUnsupported'), body: h('div', { className: 'fde-hint' }, t('matUnsupportedHint')),
          actions: h('div', { className: 'fde-row', style: { justifyContent: 'center', marginTop: 8 } },
            h(Btn, { small: true, kind: 'primary', onClick: () => p.onOpenPath(abs, 'open', file.rel, 'file') }, t('matSystemOpen')),
            p.onReveal ? h(Btn, { small: true, onClick: () => p.onReveal(abs, file.rel) }, t('reveal')) : null),
        });
      } else if (state.status === 'ready-image') {
        body = h('div', { className: 'fde-pv-center' },
          h('img', {
            className: 'fde-pv-img', src: state.src, alt: file.rel,
            onError: () => setState({ status: 'error', err: '图片加载失败' }),
          }));
      } else if (state.status === 'ready-pdf') {
        body = h('iframe', { className: 'fde-pv-frame', src: state.src, title: file.rel });
      } else if (state.status === 'ready-text') {
        if (kind === 'md') {
          body = h('div', { className: 'fde-pv-md' }, renderMarkdown(state.text, abs));
        } else if (kind === 'html') {
          body = h('div', { className: 'fde-pv-html' },
            h('div', { className: 'fde-pv-subbar' },
              h('div', { className: 'fde-seg' },
                h('button', { type: 'button', className: htmlMode === 'snapshot' ? 'on' : '', onClick: () => setHtmlMode('snapshot') }, t('matHtmlSnapshot')),
                h('button', { type: 'button', className: htmlMode === 'source' ? 'on' : '', onClick: () => setHtmlMode('source') }, t('matHtmlSource'))),
              h('div', { className: 'fde-spacer' }),
              h('span', { className: 'fde-hint' }, 'sandbox · 不执行脚本')),
            htmlMode === 'source'
              ? h('pre', { className: 'fde-pv-pre' }, state.text)
              : h('iframe', { className: 'fde-pv-frame', sandbox: '', srcDoc: state.text, title: file.rel, referrerPolicy: 'no-referrer' }));
        } else {
          body = h('pre', { className: 'fde-pv-pre' }, state.text);
        }
        if (state.note) body = h(React.Fragment, null, body, h('div', { className: 'fde-pv-note' }, state.note));
      } else {
        body = h(Empty, { mark: '▤', title: t('matPick'), body: h('div', { className: 'fde-hint' }, t('matPickHint')) });
      }

      return h('div', { className: 'fde-mat-preview' + (p.full ? ' full' : '') },
        head,
        h('div', { className: 'fde-pv-body' }, body));
    }

    /* ---- 资料页 ---- */
    function ArtifactsView(props) {
      const p = props || {};
      const meta = p.meta;
      const board = p.board || {};
      const engs = asList(board.engagements);
      const root = str(p.root || board.root || '');
      const services = p.services || {};
      const [mode, setMode] = useState(MAT_UI_MEM.mode);
      const [filesByDir, setFilesByDir] = useState({});
      const [bases, setBases] = useState({});
      const [loading, setLoading] = useState(false);
      const [loadErr, setLoadErr] = useState('');
      const [q, setQ] = useState(MAT_UI_MEM.q);
      const [cat, setCat] = useState(MAT_UI_MEM.cat);
      const [showRaw, setShowRaw] = useState(MAT_UI_MEM.showRaw);
      const [sort, setSort] = useState(MAT_UI_MEM.sort);
      const [active, setActive] = useState(null);
      const [expanded, setExpanded] = useState(MAT_UI_MEM.expanded || {});
      const [full, setFull] = useState(false);
      const [uploadOpen, setUploadOpen] = useState(false);
      const [uploadDir, setUploadDir] = useState('');
      const [drag, setDrag] = useState(false);
      const [uploadMsg, setUploadMsg] = useState('');
      const [uploading, setUploading] = useState(false);
      const [showMaterials, setShowMaterials] = useState(false);
      const [materials, setMaterials] = useState(null);
      const [loose, setLoose] = useState([]);
      const [matRoot, setMatRoot] = useState('');
      const [matFiles, setMatFiles] = useState({});
      const [syncMsg, setSyncMsg] = useState('');
      const [syncing, setSyncing] = useState(false);
      const fileInput = useRef(null);
      const alive = useRef(true);
      const autoRef = useRef(false);
      const rootRef = useRef(null);
      const bodyRef = useRef(null);
      const dragRef = useRef(null);
      const [narrow, setNarrow] = useState(false);
      const [listW, setListW] = useState(Number(MAT_UI_MEM.listWidth) || 380);
      useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

      const notify = (kind, text) => { if (p.onNotify) p.onNotify(kind, text); };
      const engKey = engs.map((e) => str(e.dir)).join('|');

      const loadAllFiles = useCallback(async () => {
        const targets = engs.filter((e) => e && e.dir);
        if (!targets.length) { setFilesByDir({}); setLoading(false); return; }
        setLoading(true);
        setLoadErr('');
        const nextFiles = {};
        const nextBases = {};
        try {
          const results = await Promise.all(targets.map(async (e) => {
            const r = await getJSON(API + '/files?dir=' + encodeURIComponent(e.dir));
            return { e, r };
          }));
          if (!alive.current) return;
          results.forEach(({ e, r }) => {
            if (r && r.ok !== false && Array.isArray(r.files)) {
              nextFiles[e.dir] = r.files;
              if (r.path) nextBases[e.dir] = str(r.path);
            } else {
              nextFiles[e.dir] = [];
            }
          });
          setFilesByDir(nextFiles);
          setBases(nextBases);
        } catch (err) {
          if (alive.current) setLoadErr(String((err && err.message) || err || t('loadFail')));
        }
        if (alive.current) setLoading(false);
      }, [engKey]);

      useEffect(() => { loadAllFiles(); }, [loadAllFiles]);
      /* 面板宽度用容器实测（窗口宽 ≠ 面板宽；1280 逻辑宽窗口下面板约 1000px，应保持左右而不是上下） */
      useEffect(() => {
        const el = rootRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver((entries) => {
          const w = entries && entries[0] && entries[0].contentRect ? entries[0].contentRect.width : 0;
          setNarrow(w > 0 && w < 860);
        });
        ro.observe(el);
        return () => ro.disconnect();
      }, []);
      useEffect(() => { if (engs.length && !uploadDir) setUploadDir(str(engs[0].dir)); }, [engKey]);

      const loadMaterials = useCallback(async () => {
        const r = await getJSON(API + '/materials');
        if (!alive.current) return;
        if (r && r.ok !== false) {
          setMaterials(asList(r.materials));
          setLoose(asList(r.loose));
          setMatRoot(str(r.root));
        } else {
          setMaterials([]);
        }
      }, []);

      /* 统一文件对象：附客户、绝对路径、分类、原始素材标记 */
      const allFiles = React.useMemo(() => {
        const out = [];
        engs.forEach((e) => {
          const dir = str(e.dir);
          const files = filesByDir[dir];
          if (!files) return;
          const base = str(bases[dir]) || (root ? matAbsJoin(matAbsJoin(root, 'research'), dir) : '');
          asList(files).forEach((f) => {
            const rel = str(f && f.rel);
            if (!rel) return;
            out.push({
              key: str(e.id) + '::' + rel,
              engId: str(e.id), engName: str(e.shortName || e.name || e.company || dir), engDir: dir, engPath: str(e.path) || base,
              rel, dirLabel: matDirLabel(rel), abs: base ? matAbsJoin(base, rel) : '',
              size: Number(f && f.size) || 0, mtime: Number(f && f.mtime) || 0,
              pdfRel: str(f && f.pdfRel), exported: !!(f && f.exported),
              raw: matIsRaw(rel), cat: matCat(rel), preview: matPreviewKind(rel),
            });
          });
        });
        return out;
      }, [engs, filesByDir, bases, root, engKey]);

      const counts = React.useMemo(() => {
        const byEng = {};
        let key = 0;
        let raw = 0;
        allFiles.forEach((f) => {
          const c = byEng[f.engId] || (byEng[f.engId] = { key: 0, raw: 0, total: 0 });
          c.total++;
          if (f.raw) { c.raw++; raw++; } else { c.key++; key++; }
        });
        return { byEng, key, raw, total: allFiles.length };
      }, [allFiles]);

      const visible = React.useMemo(() => {
        let arr = allFiles.filter((f) => showRaw || !f.raw);
        if (cat !== 'all') arr = arr.filter((f) => f.cat === cat);
        const kw = q.trim().toLowerCase();
        if (kw) arr = arr.filter((f) => (f.rel + ' ' + f.engName + ' ' + f.dirLabel).toLowerCase().indexOf(kw) >= 0);
        arr = arr.slice();
        if (sort === 'name') arr.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
        else arr.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
        return arr;
      }, [allFiles, showRaw, cat, q, sort]);

      /* 记住列表 UI 状态，回到面板时恢复 */
      useEffect(() => {
        MAT_UI_MEM.mode = mode; MAT_UI_MEM.q = q; MAT_UI_MEM.cat = cat;
        MAT_UI_MEM.showRaw = showRaw; MAT_UI_MEM.sort = sort; MAT_UI_MEM.expanded = expanded; MAT_UI_MEM.listWidth = listW;
      }, [mode, q, cat, showRaw, sort, expanded, listW]);

      useEffect(() => {
        if (autoRef.current) return;
        if (!visible.length) return;
        autoRef.current = true;
        /* 窄面板单列时不要自动选中，否则一进页面列表就被预览顶掉 */
        if (narrow) return;
        /* 首屏默认选一份「能预览」的资料，避免一进来就停在无法预览的二进制上 */
        const first = visible.find((f) => f.preview !== 'binary' && f.preview !== 'office') || visible.find((f) => f.preview !== 'binary') || visible[0];
        setActive(first);
      }, [visible.length, narrow]);

      /* 从宽变窄时，若当前只是首屏自动选中的，就退回列表，避免「一进来就是预览」 */
      useEffect(() => {
        if (narrow && autoRef.current && active) setActive(null);
      }, [narrow]);

      /* Office → PDF：用宿主 officeToPdf Remote（需要本工作区的一个会话作授权作用域） */
      const loadOfficePdf = useCallback(async (abs) => {
        const of = services.officeToPdf;
        if (!of || typeof of.render !== 'function') throw new Error(t('matOfficeNoSession'));
        const sid = pickSessionIdForRoot(root, services.sessions);
        if (!sid) throw new Error(t('matOfficeNoSession'));
        const ac = new AbortController();
        let r = await of.render(sid, abs, 'foreground', ac.signal);
        if (r && r.ok === false) r = await of.render(sid, abs, 'foreground', ac.signal);
        if (!r || r.ok === false) {
          const err = r && r.error;
          throw new Error((err && (err.message || err.code)) || t('matOfficeFail'));
        }
        const data = r.value && r.value.data;
        if (!data || !data.length) throw new Error(t('matOfficeFail'));
        return new Blob([data], { type: 'application/pdf' });
      }, [services.officeToPdf, services.sessions, root]);

      const doOpen = async (abs, mode2, label, kind) => {
        if (!abs) { notify('warn', t('noPath')); return; }
        if (p.openPath) {
          const r = await p.openPath(abs, mode2, kind || 'file');
          if (r && r.ok) { notify('ok', (mode2 === 'reveal' ? t('revealOk') : t('openOk')) + '：' + (label || abs)); return; }
          notify('warn', t('revealFail') + '：' + ((r && r.reason) || '未知原因'));
        }
      };
      const doExport = async (file) => {
        const r = await postJSON(API + '/handoff', { action: 'export', dir: file.engDir, md: file.rel }, 60000);
        if (r && r.ok && r.sessionId) { notify('ok', t('exporting')); if (p.openSession) p.openSession(r.sessionId); }
        else if (r && r.promptText) { if (p.copyText) await p.copyText(r.promptText); notify('warn', (r.reason || t('handoffFail'))); }
        else notify('warn', (r && r.reason) || t('actionFail'));
      };
      const doQa = async (file) => {
        const target = file.pdfRel || file.rel;
        const r = await postJSON(API + '/handoff', { action: 'qa', dir: file.engDir, pdf: target }, 60000);
        if (r && r.ok && r.sessionId) { notify('ok', '已下发质检任务，正在跳转…'); if (p.openSession) p.openSession(r.sessionId); }
        else if (r && r.promptText) { if (p.copyText) await p.copyText(r.promptText); notify('warn', (r.reason || t('handoffFail'))); }
        else notify('warn', (r && r.reason) || t('actionFail'));
      };
      const doSync = async () => {
        setSyncing(true); setSyncMsg('');
        const r = await fdePost('/sync', {});
        if (!alive.current) return;
        setSyncing(false);
        if (!r || r.ok === false) { notify('err', '重扫失败：' + ((r && r.reason) || '未知原因')); return; }
        setSyncMsg('已重扫工件');
        await loadAllFiles();
        if (p.onRefresh) await p.onRefresh();
      };
      const doUpload = async (fileList) => {
        const arr = Array.from(fileList || []);
        if (!arr.length) return;
        if (!uploadDir) { setUploadMsg('请先选择客户'); return; }
        setUploading(true);
        setUploadMsg(t('artifactsUploading') + '（' + arr.length + ' 个文件）');
        const payload = [];
        for (const f of arr) {
          try {
            const dataUrl = await new Promise((res, rej) => {
              const rd = new FileReader();
              rd.onload = () => res(String(rd.result || ''));
              rd.onerror = () => rej(new Error('读取失败'));
              rd.readAsDataURL(f);
            });
            payload.push({ name: f.name, data: dataUrl });
          } catch (e) { /* 跳过 */ }
        }
        const r = await postJSON(API + '/upload', { dir: uploadDir, files: payload }, 180000);
        if (!alive.current) return;
        setUploading(false);
        if (r && r.ok) {
          setUploadMsg(t('artifactsUploaded') + ' ' + asList(r.saved).length + ' 个文件');
          await loadAllFiles();
          if (p.onRefresh) await p.onRefresh();
        } else setUploadMsg((r && r.reason) || '上传失败');
      };
      const doToProject = async (dir) => {
        const r = await postJSON(API + '/toproject', { dir, company: dir }, 60000);
        if (r && r.ok) { notify('ok', t('converted') + '：' + dir); if (p.onRefresh) await p.onRefresh(); loadMaterials(); if (p.onScanNow) p.onScanNow(); }
        else notify('warn', (r && r.reason) || '转换失败');
      };
      const loadMatFiles = async (dir) => {
        if (matFiles[dir]) { const nx = Object.assign({}, matFiles); delete nx[dir]; setMatFiles(nx); return; }
        const r = await getJSON(API + '/material-files?dir=' + encodeURIComponent(dir));
        setMatFiles(Object.assign({}, matFiles, { [dir]: asList(r.files) }));
      };

      const selectFile = (f) => { setActive(f); setFull(false); };

      const fileRow = (f, opts) => {
        const o = opts || {};
        const on = active && active.key === f.key;
        return h('div', {
          key: f.key,
          className: 'fde-mat-file' + (on ? ' on' : ''),
          role: 'button', tabIndex: 0, 'aria-current': on ? 'true' : undefined,
          onClick: () => selectFile(f),
          onKeyDown: (e) => { if (e && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectFile(f); } },
        },
          h('span', { className: 'fde-mat-file-main' },
            h('span', { className: 'fde-mat-file-name', title: f.rel }, matName(f.rel)),
            o.showCustomer ? h('span', { className: 'fde-mat-file-cust' }, f.engName) : null,
            h('span', { className: 'fde-mat-file-meta' }, [f.dirLabel, matBytes(f.size), f.mtime ? relTime(f.mtime) : ''].filter(Boolean).join(' · '))),
          f.raw ? h('span', { className: 'fde-mat-raw' }, t('matRawBadge')) : null,
          h(MatMenu, {
            items: [
              { label: t('matSystemOpen'), onSelect: () => doOpen(f.abs, 'open', f.rel, 'file') },
              { label: t('reveal'), onSelect: () => doOpen(f.abs, 'reveal', f.rel, 'file') },
              { label: t('matCopyPath'), onSelect: () => { if (p.copyText) p.copyText(f.abs); } },
            ],
          }));
      };

      const hasFilter = q.trim() !== '' || cat !== 'all';
      const customerBlock = (eng) => {
        const dir = str(eng.dir);
        const c = counts.byEng[eng.id] || { key: 0, raw: 0, total: 0 };
        const files = visible.filter((f) => f.engId === eng.id);
        /* 搜索/类型筛选时只展开有命中的客户组，避免把空组全部撑开 */
        const open = !!expanded[eng.id] || (hasFilter && files.length > 0);
        const shown = files.slice(0, 80);
        return h('div', { key: eng.id, className: 'fde-mat-cust-item' },
          h('div', {
            className: 'fde-mat-cust', role: 'button', tabIndex: 0, 'aria-expanded': open ? 'true' : 'false',
            onClick: () => setExpanded((cur) => Object.assign({}, cur, { [eng.id]: !expanded[eng.id] })),
            onKeyDown: (e) => { if (e && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setExpanded((cur) => Object.assign({}, cur, { [eng.id]: !expanded[eng.id] })); } },
          },
            h('span', { className: 'fde-caret' + (open ? ' open' : ''), 'aria-hidden': 'true' }, '›'),
            h('span', { className: 'fde-mat-cust-name' }, str(eng.shortName || eng.name || eng.company || dir)),
            eng.stage ? Chip({ tone: 'muted', children: stageLabel(meta, eng.stage) }) : null,
            h('div', { className: 'fde-spacer' }),
            h('span', { className: 'fde-hint' }, t('matKeyCount') + ' ' + c.key + (c.raw ? ' · ' + t('matRawCount') + ' ' + c.raw : ''))),
          open
            ? h('div', { className: 'fde-mat-cust-files' },
              files.length === 0
                ? h('div', { className: 'fde-hint', style: { padding: '6px 10px' } }, showRaw ? t('matNoMatch') : t('matEmpty') + '（' + t('matRawCount') + ' ' + c.raw + '）')
                : shown.map((f) => fileRow(f)),
              files.length > shown.length ? h('div', { className: 'fde-hint', style: { padding: '6px 10px' } }, '仅显示前 ' + shown.length + ' 个（共 ' + files.length + ' 个）。') : null)
            : null);
      };

      const recentList = () => {
        const shown = visible.slice(0, 120);
        return h('div', { className: 'fde-mat-recent' },
          shown.length === 0
            ? h(Empty, {
              mark: '▤', title: q || cat !== 'all' ? t('matNoMatch') : t('matEmpty'),
              body: h('div', { className: 'fde-hint' }, q || cat !== 'all' ? t('matNoMatchHint') : t('matEmptyHint')),
              actions: !showRaw && counts.raw > 0
                ? h('div', { style: { marginTop: 8 } }, h(Btn, { small: true, onClick: () => setShowRaw(true) }, t('matRawToggle') + '（' + counts.raw + '）'))
                : null,
            })
            : shown.map((f) => fileRow(f, { showCustomer: true })),
          visible.length > shown.length ? h('div', { className: 'fde-hint', style: { padding: '8px 10px' } }, '仅显示最近 ' + shown.length + ' 份（共 ' + visible.length + ' 份）。') : null);
      };

      const uploadPanel = () => h('div', { className: 'fde-mat-upload' },
        h('div', { className: 'fde-row', style: { marginBottom: 6 } },
          h(Select, {
            value: uploadDir, ariaLabel: t('artifactsPick'),
            options: [{ value: '', label: '（选择客户）' }].concat(engs.filter((e) => e.dir).map((e) => ({ value: str(e.dir), label: str(e.shortName || e.name || e.dir) }))),
            onChange: (e) => setUploadDir(e.target.value),
          }),
          h('span', { className: 'fde-hint' }, '→ raw/uploads/'),
          h('div', { className: 'fde-spacer' }),
          h(Btn, { small: true, onClick: () => setUploadOpen(false) }, t('close'))),
        h('div', {
          className: 'fde-drop fde-mat-drop' + (drag ? ' on' : ''),
          role: 'button', tabIndex: 0, 'aria-label': t('artifactsUploadTitle'),
          onDragOver: (e) => { if (e && e.preventDefault) e.preventDefault(); setDrag(true); },
          onDragLeave: () => setDrag(false),
          onDrop: (e) => { if (e && e.preventDefault) e.preventDefault(); setDrag(false); doUpload(e && e.dataTransfer && e.dataTransfer.files); },
          onClick: () => { if (fileInput.current) fileInput.current.click(); },
          onKeyDown: (e) => { if (e && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); if (fileInput.current) fileInput.current.click(); } },
        },
          h('div', { style: { fontWeight: 600 } }, uploading ? t('artifactsUploading') : t('artifactsUploadTitle')),
          h('div', { className: 'fde-hint' }, t('artifactsUploadHint')),
          h('input', { ref: fileInput, type: 'file', multiple: true, style: { display: 'none' }, onChange: (e) => { doUpload(e.target.files); if (e && e.target) e.target.value = ''; } })),
        uploadMsg ? h('div', { className: 'fde-hint', style: { marginTop: 6 } }, uploadMsg) : null);

      const renderMatFiles = (m) => {
        const list = matFiles[m.dir];
        if (!list) return null;
        return h('div', { className: 'fde-mat-subfiles' }, list.slice(0, 20).map((f) =>
          h('div', { key: f.rel, className: 'fde-mat-subfile' },
            h('span', { className: 'fde-mat-file-name' }, f.rel),
            h(MatMenu, {
              items: [
                { label: t('matSystemOpen'), onSelect: () => doOpen(matAbsJoin(m.path, f.rel), 'open', f.rel, 'file') },
                { label: t('reveal'), onSelect: () => doOpen(matAbsJoin(m.path, f.rel), 'reveal', f.rel, 'file') },
              ],
            }))));
      };
      const materialsPanel = () => {
        const mats = materials || [];
        const count = mats.length + loose.length;
        const rows = mats.map((m) => h('div', { key: m.dir, className: 'fde-mat-file' },
          h('span', { className: 'fde-mat-file-main' },
            h('span', { className: 'fde-mat-file-name' }, m.dir),
            h('span', { className: 'fde-mat-file-meta' }, m.fileCount + ' ' + t('artifactsFiles') + ' · ' + relTime(m.mtime))),
          h(MatMenu, {
            items: [
              { label: t('matOpenDir'), onSelect: () => doOpen(m.path, 'open', m.dir, 'dir') },
              { label: t('artifactsViewFiles'), onSelect: () => loadMatFiles(m.dir) },
              { label: t('artifactsToProject'), onSelect: () => doToProject(m.dir) },
            ],
          }),
          renderMatFiles(m)));
        const looseRows = loose.slice(0, 40).map((f) => h('div', { key: 'loose-' + f.name, className: 'fde-mat-file' },
          h('span', { className: 'fde-mat-file-main' },
            h('span', { className: 'fde-mat-file-name' }, f.name),
            h('span', { className: 'fde-mat-file-meta' }, matBytes(f.size))),
          h(MatMenu, {
            items: [
              { label: t('matSystemOpen'), onSelect: () => doOpen(matAbsJoin(matRoot, f.name), 'open', f.name, 'file') },
              { label: t('reveal'), onSelect: () => doOpen(matAbsJoin(matRoot, f.name), 'reveal', f.name, 'file') },
            ],
          })));
        return h('div', { className: 'fde-mat-materials' },
          h('div', {
            className: 'fde-mat-cust', role: 'button', tabIndex: 0, 'aria-expanded': showMaterials ? 'true' : 'false',
            onClick: () => { if (materials === null) loadMaterials(); setShowMaterials((v) => !v); },
            onKeyDown: (e) => { if (e && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); if (materials === null) loadMaterials(); setShowMaterials((v) => !v); } },
          },
            h('span', { className: 'fde-caret' + (showMaterials ? ' open' : ''), 'aria-hidden': 'true' }, '›'),
            h('span', { className: 'fde-mat-cust-name' }, t('matMaterials')),
            h('div', { className: 'fde-spacer' }),
            h('span', { className: 'fde-hint' }, count ? String(count) + ' ' + t('artifactsFiles') : '')),
          showMaterials
            ? h('div', { className: 'fde-mat-cust-files' },
              h('div', { className: 'fde-hint', style: { padding: '6px 10px' } }, t('matMaterialsHint')),
              materials === null ? h(Loading, { text: t('loading') }) : null,
              rows,
              loose.length ? h('div', { className: 'fde-hint', style: { padding: '8px 10px 2px' } }, t('artifactsLoose') + '（' + loose.length + '）') : null,
              looseRows,
              loose.length > 40 ? h('div', { className: 'fde-hint', style: { padding: '2px 10px 6px' } }, '仅显示前 40 个（共 ' + loose.length + ' 个）。') : null)
            : null);
      };

      const countsText = loading ? '…' : (counts.key + ' ' + t('matKeyCount') + (counts.raw ? ' · ' + counts.raw + ' ' + t('matRawCount') : ''));
      const cats = [
        { key: 'all', label: t('matAll') },
        { key: 'doc', label: t('matDoc') },
        { key: 'pdf', label: t('matPdf') },
        { key: 'office', label: t('matOffice') },
        { key: 'image', label: t('matImage') },
        { key: 'web', label: t('matWeb') },
        { key: 'other', label: t('matOther') },
      ];

      const toolbar = h('div', { className: 'fde-mat-head' },
        h('div', { className: 'fde-mat-title-row' },
          h('div', { className: 'fde-mat-title' }, t('matTitle')),
          h('span', { className: 'fde-hint' }, countsText),
          h('div', { className: 'fde-spacer' }),
          h('input', {
            className: 'fde-input fde-mat-search', type: 'search', value: q,
            placeholder: t('matSearchPh'), 'aria-label': t('matSearchPh'),
            onChange: (e) => setQ(e.target.value),
          }),
          h(Btn, { small: true, onClick: () => setUploadOpen((v) => !v), kind: uploadOpen ? 'primary' : undefined }, t('matUpload')),
          h(Btn, { small: true, onClick: doSync, busy: syncing }, syncing ? '重扫中…' : t('artifactsRefresh'))),
        h('div', { className: 'fde-mat-filters' },
          h('div', { className: 'fde-seg' },
            h('button', { type: 'button', className: mode === 'recent' ? 'on' : '', onClick: () => setMode('recent') }, t('matRecent')),
            h('button', { type: 'button', className: mode === 'customer' ? 'on' : '', onClick: () => setMode('customer') }, t('matByCustomer'))),
          h('div', { className: 'fde-mat-pills' }, cats.map((c) => h('button', {
            key: c.key, type: 'button', className: 'fde-pill' + (cat === c.key ? ' on' : ''),
            onClick: () => setCat(c.key),
          }, c.label))),
          h('div', { className: 'fde-spacer' }),
          h('button', {
            type: 'button', className: 'fde-pill' + (showRaw ? ' on' : ''),
            onClick: () => setShowRaw((v) => !v), title: t('matRawToggle'),
          }, t('matRawToggle') + (counts.raw ? '（' + counts.raw + '）' : '')),
          h('button', {
            type: 'button', className: 'fde-pill' + (sort === 'name' ? ' on' : ''),
            onClick: () => setSort((v) => (v === 'name' ? 'recent' : 'name')),
          }, sort === 'name' ? t('matSortName') : t('matSortRecent'))));

      /* 左右拖动分隔条调整列表宽度：默认 380，限制 280 ～ (容器宽 - 320)；
         鼠标拖动 + 键盘 ←/→（Shift 加速）+ Home/End，宽度存模块内存，切面板回来仍保留。 */
      const splitMax = () => {
        const el = bodyRef.current;
        const w = el ? el.getBoundingClientRect().width : 0;
        return Math.max(300, Math.round(w - 320));
      };
      const onSplitterDown = (e) => {
        if (!e) return;
        if (e.preventDefault) e.preventDefault();
        dragRef.current = { startX: Number(e.clientX) || 0, startW: listW, maxW: splitMax() };
        const move = (ev) => {
          const d = dragRef.current;
          if (!d) return;
          const next = Math.min(d.maxW, Math.max(300, d.startW + (Number(ev.clientX) || 0) - d.startX));
          setListW(Math.round(next));
        };
        const up = () => {
          dragRef.current = null;
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      };
      const onSplitterKey = (e) => {
        if (!e || !e.key) return;
        const step = (e.shiftKey ? 48 : 16);
        if (e.key === 'ArrowLeft') { if (e.preventDefault) e.preventDefault(); setListW((w) => Math.max(300, w - step)); }
        else if (e.key === 'ArrowRight') { if (e.preventDefault) e.preventDefault(); setListW((w) => Math.min(splitMax(), w + step)); }
        else if (e.key === 'Home') { if (e.preventDefault) e.preventDefault(); setListW(300); }
        else if (e.key === 'End') { if (e.preventDefault) e.preventDefault(); setListW(splitMax()); }
      };
      const splitter = h('div', {
        className: 'fde-mat-splitter',
        role: 'separator',
        'aria-orientation': 'vertical',
        'aria-label': t('matSplitHint'),
        title: t('matSplitHint'),
        tabIndex: 0,
        onMouseDown: onSplitterDown,
        onKeyDown: onSplitterKey,
      });

      const listPane = h('div', { className: 'fde-mat-list', style: narrow ? undefined : { flex: '0 0 ' + listW + 'px' } },
        uploadOpen ? uploadPanel() : null,
        loading && !allFiles.length ? h(Loading, { text: '正在读取客户资料…' }) : null,
        !loading && mode === 'recent' ? recentList() : null,
        !loading && mode === 'customer' ? h('div', { className: 'fde-mat-custs' }, engs.map(customerBlock)) : null,
        materialsPanel());
      const previewPane = h(FilePreview, {
        file: active,
        full,
        onBack: narrow ? () => setActive(null) : null,
        onToggleFull: (v) => setFull(!!v),
        onClose: narrow ? null : (active ? () => setActive(null) : null),
        officeToPdf: loadOfficePdf,
        onOpenPath: p.openPath,
        onReveal: p.openPath ? (abs, rel) => p.openPath(abs, 'reveal', rel, 'file') : null,
        onExport: doExport,
        onQa: doQa,
      });
      const body = engs.length === 0
        ? h(Empty, {
          mark: '▤', title: t('artifactsNoCustomer'),
          actions: h('div', { style: { marginTop: 8 } }, h(Btn, { small: true, kind: 'primary', onClick: p.onOpenCustomers }, t('customersTitle'))),
        })
        : h('div', { className: 'fde-mat-body' + (narrow ? ' narrow' : ''), ref: bodyRef },
          narrow ? (active ? previewPane : listPane) : h(React.Fragment, null, listPane, splitter, previewPane));

      return h('div', { className: 'fde-materials', ref: rootRef },
        toolbar,
        syncMsg ? h(MsgLine, { kind: 'ok', text: syncMsg, onClose: () => setSyncMsg('') }) : null,
        loadErr ? h(ErrorLine, { title: t('matLoadFail'), text: loadErr, onRetry: loadAllFiles }) : null,
        body);
    }

    /* 从 sessions 快照里挑一个当前工作区的会话，作为 workspaceFiles/officeToPdf 的授权作用域。
       预览是本工作区只读操作，复用任一该工作区会话，不创建会话、不切换会话。 */
    function pickSessionIdForRoot(root, sessions) {
      try {
        const snap = sessions && sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : null;
        const ids = asList(snap && snap.ids);
        if (!ids.length) return '';
        const base = str(root).replace(/\/+$/, '');
        const cwdOf = (id) => str(snap && snap.byId ? (snap.byId[id] || {}).cwd : '').replace(/\/+$/, '');
        const updatedOf = (id) => Number((snap && snap.byId ? (snap.byId[id] || {}).updatedAt : 0)) || 0;
        /* 优先本工作区、且最近更新过的会话：切过去看原生预览时落在用户刚才的上下文里 */
        const inRoot = ids.filter((id) => {
          const cwd = cwdOf(id);
          return !base || (cwd && (cwd === base || cwd.indexOf(base + '/') === 0));
        });
        const pool = inRoot.length ? inRoot : ids;
        pool.sort((a, b) => updatedOf(b) - updatedOf(a));
        return str(pool[0]);
      } catch (e) {
        return '';
      }
    }

    /* ============================================================
     * 九、招采视图（第 6 页签，spec §17.7）
     * 数据概况 → 检索（q/mode/日期/来源）→ 结果列表 → 按客户匹配概览
     * → 导入链接（仅 bid-intel 路由可用时显示）。
     * 招采服务不可用（available:false / 路由缺失）时整页降级为未就绪提示。
     * ============================================================ */
    function BidsView(props) {
      const p = props || {};
      const board = p.board || {};
      const [statsResp, setStatsResp] = useState(null);
      const [statsLoading, setStatsLoading] = useState(false);
      const [statsError, setStatsError] = useState('');
      const [q, setQ] = useState('');
      const [mode, setMode] = useState('any');
      const [from, setFrom] = useState('');
      const [to, setTo] = useState('');
      const [source, setSource] = useState('');
      const [results, setResults] = useState(null);
      const [searchLoading, setSearchLoading] = useState(false);
      const [searchError, setSearchError] = useState('');
      const [expanded, setExpanded] = useState({});
      const [importReady, setImportReady] = useState(null);
      const [importUrl, setImportUrl] = useState('');
      const [importing, setImporting] = useState(false);
      const [importMsg, setImportMsg] = useState(null);
      const alive = useRef(true);
      useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

      const loadStats = useCallback(async () => {
        setStatsLoading(true); setStatsError('');
        const r = await fdeGet('/bids/stats');
        if (!alive.current) return;
        setStatsLoading(false);
        if (r && r.ok === false) setStatsError(r.reason || t('loadFail'));
        setStatsResp(normalizeBidStatsResp(r));
      }, []);

      /* 「导入链接」只在 bid-intel 同源路由可用时显示（探测失败即隐藏） */
      const probeImport = useCallback(async () => {
        const r = await getJSON('/bidintel/api/status');
        if (!alive.current) return;
        setImportReady(!!(r && r.ok !== false));
      }, []);

      const runSearch = useCallback(async (form, offset) => {
        const f = form || {};
        const base = offset || 0;
        setSearchLoading(true); setSearchError('');
        const qs = [
          'q=' + encodeURIComponent(str(f.q)),
          'mode=' + encodeURIComponent(str(f.mode || 'any')),
          'from=' + encodeURIComponent(str(f.from)),
          'to=' + encodeURIComponent(str(f.to)),
          'source=' + encodeURIComponent(str(f.source)),
          'limit=20',
          'offset=' + base,
        ].join('&');
        const r = await getJSON(FDE + '/bids/search?' + qs);
        if (!alive.current) return;
        setSearchLoading(false);
        if (r && r.ok === false && r.available !== false) setSearchError(r.reason || '检索失败');
        if (r && r.available === false) setSearchError('');
        const n = normalizeBidSearchResp(r);
        setResults((cur) => {
          if (!base) return n;
          const prev = cur || n;
          return Object.assign({}, n, { items: asList(prev.items).concat(n.items) });
        });
      }, []);

      useEffect(() => {
        loadStats();
        probeImport();
        runSearch({ q: '', mode: 'any', from: '', to: '', source: '' }, 0);
      }, [loadStats, probeImport, runSearch]);

      const bidStat = (num, label) => h('div', { className: 'fde-stat' },
        h('div', { className: 'fde-stat-num fde-stat-num-sm' }, num === undefined || num === null || num === '' ? '—' : String(num)),
        h('div', { className: 'fde-stat-label' }, label));
      const stats = statsResp;
      const available = !!(stats && stats.available);
      const items = asList(results && results.items);
      const total = results ? Number(results.total) || items.length : 0;
      const boardStats = normalizeBoardBidStats(board);
      const overview = asList(board.engagements).map((eng) => ({
        eng,
        bids: engagementBids(eng),
      })).filter((x) => x.bids.available && x.bids.total > 0)
        .sort((a, b) => (b.bids.total - a.bids.total));

      const doRefresh = async () => {
        await loadStats();
        await runSearch({ q, mode, from, to, source }, 0);
        if (p.onRefresh) await p.onRefresh();
      };

      const submitSearch = () => { runSearch({ q, mode, from, to, source }, 0); };
      const loadMore = () => { if (results && items.length < total) runSearch({ q, mode, from, to, source }, items.length); };
      const toggleRow = (key) => setExpanded((cur) => Object.assign({}, cur, { [key]: !cur[key] }));

      const doImport = async () => {
        const url = str(importUrl).trim();
        if (!url) { setImportMsg({ kind: 'warn', text: t('bidImportNeedUrl') }); return; }
        setImporting(true); setImportMsg(null);
        const r = await postJSON('/bidintel/api/import-url', { url }, 30000);
        if (!alive.current) return;
        setImporting(false);
        if (r && r.ok) {
          const title = str(r.item && r.item.title);
          setImportMsg({ kind: 'ok', text: t('bidImportOk') + (title ? '：' + title : '') });
          setImportUrl('');
          await loadStats();
          await runSearch({ q, mode, from, to, source }, 0);
        } else {
          setImportMsg({ kind: 'warn', text: (r && r.reason) || t('bidImportFail') });
        }
      };

      const sourceOptions = [{ value: '', label: t('all') + '来源' }].concat(
        asList(stats && stats.sources).map((s) => ({ value: s.name, label: s.name + '（' + s.count + '）' }))
      );

      const resultRow = (item, idx) => {
        const rel = bidRelationMeta(bidRelationDerived(item));
        const open = !!expanded[item.key];
        return h('div', { key: item.key || 'row-' + idx, className: 'fde-bid-row' },
          h('div', { className: 'fde-bid-main' },
            h('div', { className: 'fde-bid-title' },
              h('span', { className: 'fde-bid-rel fde-bid-rel-' + rel.key }, rel.label),
              h('span', { className: 'fde-bid-title-text' }, item.title)),
            h('div', { className: 'fde-bid-meta' },
              item.date ? h('span', { className: 'fde-num' }, fmtDay(item.date)) : null,
              item.kind ? Chip({ tone: 'muted', children: item.kind }) : null,
              item.buyer ? h('span', { className: 'fde-bid-kv', title: t('bidBuyer') }, t('bidBuyer') + '：' + item.buyer) : null,
              item.winner ? h('span', { className: 'fde-bid-kv', title: t('bidWinner') }, t('bidWinner') + '：' + item.winner) : null,
              item.amountText ? h('span', { className: 'fde-bid-kv', title: t('bidAmountTip') }, t('bidAmount') + '：' + item.amountText) : null,
              item.source ? h('span', { className: 'fde-dim' }, item.source) : null),
            open
              ? h('div', { className: 'fde-bid-expand' },
                item.projectNo ? h('div', { className: 'fde-hint' }, '招标编号：' + item.projectNo) : null,
                item.excerpt ? h('div', { className: 'fde-bid-excerpt' }, item.excerpt) : null,
                item.candidates.length
                  ? h('div', { className: 'fde-bid-cands' },
                    h('div', { className: 'fde-hint' }, t('bidCandidatesNote')),
                    item.candidates.slice(0, 8).map((c) => h('span', { key: c.key, className: 'fde-chip' + (c.rank === 1 ? ' accent' : '') },
                      (c.rank ? '第 ' + c.rank + ' 名 · ' : '') + c.name)))
                  : h('div', { className: 'fde-hint' }, t('bidNoCandidates')),
                item.url
                  ? h('a', { className: 'fde-link', href: item.url, target: '_blank', rel: 'noreferrer noopener' }, t('bidOpenSource'))
                  : h('span', { className: 'fde-hint' }, t('bidNoUrl')))
              : null),
          h('div', { className: 'fde-bid-actions' },
            h(Btn, { small: true, onClick: () => toggleRow(item.key), ariaLabel: (open ? t('bidCollapse') : t('bidExpand')) + '：' + item.title },
              open ? t('bidCollapse') : t('bidExpand')),
            item.url
              ? h('a', { className: 'fde-link fde-link-btn', href: item.url, target: '_blank', rel: 'noreferrer noopener' }, t('bidOpenSource'))
              : null));
      };

      return h('div', { className: 'fde-view' },
        /* ---- 数据概况 ---- */
        h('div', { className: 'fde-card' },
          Section({
            title: t('bidTitle'),
            extra: h('span', { className: 'fde-hint' }, t('bidPageHint')),
            actions: h(Btn, { small: true, onClick: doRefresh, disabled: !!p.busy || statsLoading }, t('bidRefresh')),
            children: [
              statsLoading && !stats ? h(Loading, { key: 'l', text: '正在读取招采索引…' }) : null,
              statsError && !stats ? h(ErrorLine, { key: 'e', title: t('loadFail'), text: statsError, onRetry: loadStats }) : null,
              stats && !available
                ? h(BidUnavailable, { key: 'u', reason: stats.reason, onRetry: loadStats })
                : null,
              stats && available
                ? h('div', { key: 'ok' },
                  h('div', { className: 'fde-stats' },
                    bidStat(stats.records, t('bidStatsRecords')),
                    bidStat(bidRangeText(stats.dateRange), t('bidStatsRange')),
                    bidStat(stats.sources.length, t('bidStatsSources')),
                    bidStat(stats.mtime ? relTime(stats.mtime) : (stats.generatedAt ? relTime(stats.generatedAt) : ''), t('bidStatsUpdated'))),
                  h('div', { className: 'fde-row', style: { marginTop: 8 } },
                    h('span', { className: 'fde-hint' }, t('bidStatsSources') + '：' + bidSourcesText(stats)))
                )
                : null,
            ],
          })),
        /* ---- 检索 + 结果 ---- */
        h('div', { className: 'fde-card' },
          Section({
            title: t('bidSearchTitle'),
            children: [
              h('div', { className: 'fde-bid-form' },
                h(TextInput, {
                  value: q, placeholder: t('bidSearchPh'), ariaLabel: t('bidSearchPh'),
                  onChange: (e) => setQ(e.target.value),
                  onKeyDown: (e) => { if (e && e.key === 'Enter') submitSearch(); },
                }),
                h(Select, {
                  value: mode, ariaLabel: t('bidModeLabel'),
                  options: [
                    { value: 'any', label: t('bidModeAny') },
                    { value: 'company', label: t('bidModeCompany') },
                    { value: 'buyer', label: t('bidModeBuyer') },
                    { value: 'title', label: t('bidModeTitle') },
                  ],
                  onChange: (e) => setMode(e.target.value),
                }),
                h(TextInput, { type: 'date', value: from, ariaLabel: t('bidFrom'), onChange: (e) => setFrom(e.target.value) }),
                h(TextInput, { type: 'date', value: to, ariaLabel: t('bidTo'), onChange: (e) => setTo(e.target.value) }),
                h(Select, {
                  value: source, ariaLabel: t('bidSource'),
                  options: sourceOptions,
                  onChange: (e) => setSource(e.target.value),
                }),
                h(Btn, { small: true, kind: 'primary', onClick: submitSearch, busy: searchLoading }, searchLoading ? t('bidSearching') : t('bidSearch')),
                h(Btn, { small: true, onClick: loadMore, disabled: searchLoading || !results || items.length >= total }, t('bidLoadMore'))),
              results && results.available === false
                ? h(BidUnavailable, { key: 'u', reason: results.reason, onRetry: doRefresh })
                : null,
              searchError ? h(MsgLine, { kind: 'warn', text: searchError, onClose: () => setSearchError('') }) : null,
              searchLoading && !items.length ? h(Loading, { key: 'l', text: t('bidSearching') }) : null,
              (results && items.length === 0 && !searchLoading)
                ? h(Empty, { key: 'e', mark: '⌕', title: t('bidNoResult'), body: t('bidNoResultHint') })
                : null,
              items.length
                ? h('div', { key: 'list' },
                  h('div', { className: 'fde-row', style: { margin: '6px 0' } },
                    h('span', { className: 'fde-hint' }, t('bidTotalPrefix') + total + t('bidTotalSuffix')),
                    results && typeof results.direct === 'number' ? h('span', { className: 'fde-hint' }, '直接命中 ' + results.direct) : null,
                    results && typeof results.mentioned === 'number' ? h('span', { className: 'fde-hint' }, '文中提及 ' + results.mentioned) : null,
                    h('div', { className: 'fde-spacer' }),
                    items.length < total
                      ? h(Btn, { small: true, onClick: loadMore, disabled: searchLoading }, t('bidLoadMore'))
                      : null),
                  h('div', { className: 'fde-bid-list' }, items.map(resultRow)),
                  items.length < total
                    ? h('div', { className: 'fde-row', style: { justifyContent: 'center', marginTop: 8 } },
                      h(Btn, { small: true, onClick: loadMore, disabled: searchLoading }, t('bidLoadMore')))
                    : null)
                : null,
            ],
          })),
        /* ---- 按客户匹配概览 ---- */
        h('div', { className: 'fde-card' },
          Section({
            title: t('bidByCustomer'),
            extra: h('span', { className: 'fde-hint' },
              boardStats && boardStats.available
                ? '索引 ' + (boardStats.records === null ? '—' : boardStats.records) + ' 条 · 区间 ' + bidRangeText(boardStats.dateRange) + ' · ' + boardStats.engagedCount + ' 个客户有匹配'
                : t('bidByCustomerHint')),
            children: overview.length
              ? h('div', { className: 'fde-list' }, overview.map((x) => h('button', {
                key: x.eng.id,
                type: 'button',
                className: 'fde-li',
                style: { background: 'transparent', border: 0, width: '100%', textAlign: 'left', font: 'inherit', color: 'inherit', cursor: 'pointer' },
                onClick: () => p.onOpenEngagement && p.onOpenEngagement(x.eng.id),
              },
                h('div', { className: 'fde-li-main' },
                  h('div', { className: 'fde-li-title' }, x.eng.name || x.eng.shortName || x.eng.dir || '—'),
                  h('div', { className: 'fde-li-meta' },
                    Chip({ tone: 'accent', children: '招采 ' + x.bids.total }),
                    Chip({ tone: 'on', children: t('bidTender') + ' ' + x.bids.tender }),
                    Chip({ tone: 'ok', children: t('bidAward') + ' ' + x.bids.award }),
                    Chip({ tone: 'warn', children: t('bidCandidateCount') + ' ' + x.bids.candidate }),
                    x.bids.latest ? h('span', { className: 'fde-dim' }, t('bidLatest') + ' ' + fmtDay(x.bids.latest)) : null)))))
              : h('div', { className: 'fde-hint' }, boardStats && boardStats.available ? t('bidNoCustomerBids') : t('bidNotReady')),
          })),
        /* ---- 导入链接（仅 bid-intel 路由可用时显示） ---- */
        importReady === true
          ? h('div', { key: 'import', className: 'fde-card' },
            Section({
              title: t('bidImportTitle'),
              extra: h('span', { className: 'fde-hint' }, t('bidImportHint')),
              children: [
                h('div', { className: 'fde-bid-form' },
                  h(TextInput, {
                    value: importUrl, placeholder: t('bidImportPh'), ariaLabel: t('bidImportPh'),
                    onChange: (e) => setImportUrl(e.target.value),
                    onKeyDown: (e) => { if (e && e.key === 'Enter') doImport(); },
                  }),
                  h(Btn, { small: true, kind: 'primary', onClick: doImport, busy: importing, disabled: importing }, importing ? t('bidImporting') : t('bidImport'))),
                importMsg ? h(MsgLine, { kind: importMsg.kind, text: importMsg.text, onClose: () => setImportMsg(null) }) : null,
              ],
            }))
          : null);
    }

    /* ============================================================
     * 十、资料库视图（第 5 页签，spec §19.6）
     * 数据：GET /fde/library/feed 读宿主缓存；POST /fde/library/refresh
     * {force:true} 触发刷新。资料库是只读资料层：标题/摘要一律按纯文本
     * 渲染，不注入 HTML；外链只认 https?://，经 window.open(_blank,
     * noopener,noreferrer) 打开；不调用任何外部写接口。
     * ============================================================ */
    const LIB_GROUP_KEYS = ['all', 'intl-official', 'cn-official', 'opensource', 'method', 'community'];
    const LIB_SORT_KEYS = ['recommend', 'latest', 'hot'];
    const LIB_KIND_LABEL_KEYS = {
      doc: 'libKindDoc', whitepaper: 'libKindWhitepaper', guide: 'libKindGuide', playbook: 'libKindPlaybook',
      blog: 'libKindBlog', course: 'libKindCourse', report: 'libKindReport', case: 'libKindCase',
      job: 'libKindJob', repo: 'libKindRepo', template: 'libKindTemplate', post: 'libKindPost',
    };

    /* 外链安全：只认 http(s)，统一 noopener,noreferrer（资料库与招采复用） */
    function isSafeUrl(url) {
      return /^https?:\/\//i.test(str(url).trim());
    }

    function openExternal(url) {
      if (!isSafeUrl(url)) return false;
      try {
        if (typeof window !== 'undefined' && typeof window.open === 'function') {
          window.open(str(url).trim(), '_blank', 'noopener,noreferrer');
          return true;
        }
      } catch (e) { /* 打开失败不阻塞面板 */ }
      return false;
    }

    function libGroupLabel(key) {
      const map = {
        all: t('libGroupAll'), 'intl-official': t('libGroupIntl'), 'cn-official': t('libGroupCn'),
        opensource: t('libGroupOpen'), method: t('libGroupMethod'), community: t('libGroupCommunity'),
      };
      return map[str(key)] || str(key);
    }

    function libKindLabel(kind) {
      const k = LIB_KIND_LABEL_KEYS[str(kind)];
      return k ? t(k) : (str(kind) || t('unknown'));
    }

    function libAuthorityKey(authority) {
      const a = str(authority).toUpperCase();
      return a === 'A' || a === 'B' || a === 'C' ? a : 'C';
    }

    function libAuthorityLabel(authority) {
      const a = libAuthorityKey(authority);
      if (a === 'A') return t('libAuthA');
      if (a === 'B') return t('libAuthB');
      return t('libAuthC');
    }

    function libSortLabel(key) {
      if (key === 'latest') return t('libSortLatest');
      if (key === 'hot') return t('libSortHot');
      return t('libSortRecommend');
    }

    function libTimeValue(v) {
      const n = new Date(str(v)).getTime();
      return isNaN(n) ? 0 : n;
    }

    /* 「今天 20:30」/「2026-11-03 20:30」；today 取宿主返回的本地日期 */
    function libUpdatedText(iso, today) {
      if (!iso) return '';
      const d = new Date(str(iso));
      if (isNaN(d.getTime())) return str(iso).slice(0, 16).replace('T', ' ');
      const clock = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
      return localDate(d) === str(today || todayStr()) ? t('libToday') + ' ' + clock : fmtDateTime(iso);
    }

    function libHost(url) {
      const m = /^https?:\/\/([^/?#]+)/i.exec(str(url));
      return m ? m[1] : '';
    }

    function libStageLabels(item, meta) {
      const keys = asList(item && item.stages).map(str).filter(Boolean);
      if (!keys.length || keys.indexOf('all') !== -1) return [t('libStageAllChip')];
      return keys.map((k) => stageLabel(meta, k));
    }

    function libIsFeatured(item, featuredSet) {
      return !!(item && (item.featured || (featuredSet && featuredSet[item.id])));
    }

    function normalizeLibraryItem(raw, idx) {
      const x = raw && typeof raw === 'object' ? raw : {};
      const live = x.liveMeta && typeof x.liveMeta === 'object' ? x.liveMeta : {};
      const stat = x.staticMeta && typeof x.staticMeta === 'object' ? x.staticMeta : {};
      const repoMeta = Object.keys(live).length ? live : stat;
      const comm = x.community && typeof x.community === 'object' ? x.community : {};
      const commStats = comm.stats && typeof comm.stats === 'object' ? comm.stats : {};
      const communityAt = str(pick(comm.publishedAt, x.addedAt, x.verifiedAt));
      return {
        id: str(x.id) || ('lib-item-' + idx),
        group: str(x.group) || 'method',
        kind: str(x.kind) || 'doc',
        lang: str(x.lang),
        title: str(pick(x.title, comm.title)) || t('unknown'),
        publisher: str(pick(x.publisher, x.author, comm.author)),
        url: str(x.url),
        authority: libAuthorityKey(x.authority),
        stages: asList(x.stages).map(str).filter(Boolean),
        topics: asList(x.topics).map(str).filter(Boolean),
        summary: str(pick(x.summary, comm.summary)),
        why: str(x.why),
        recommend: str(x.recommend),
        featured: !!x.featured,
        addedAt: str(pick(x.addedAt, comm.publishedAt)),
        verifiedAt: str(x.verifiedAt),
        note: str(x.note),
        repo: str(x.repo),
        stars: Number(repoMeta.stars) || 0,
        forks: Number(repoMeta.forks) || 0,
        license: str(repoMeta.license),
        language: str(repoMeta.language),
        pushedAt: str(repoMeta.pushedAt),
        isNew: !!x.isNew,
        updated: !!x.updated,
        community: {
          author: str(comm.author),
          publishedAt: str(comm.publishedAt),
          read: Number(commStats.read) || 0,
          like: Number(commStats.like) || 0,
          comment: Number(commStats.comment) || 0,
          tags: asList(comm.tags).map(str).filter(Boolean),
        },
        activeAt: communityAt,
      };
    }

    function normalizeLibraryFeed(raw) {
      const resp = raw && typeof raw === 'object' ? raw : {};
      const today = str(resp.today) || todayStr();
      const f = resp.feed && typeof resp.feed === 'object' ? resp.feed : null;
      const code = str(resp.code);
      const reason = str(resp.reason);
      if (!f) {
        return {
          feed: null, today, stale: resp.stale !== false, refreshing: !!resp.refreshing,
          code, reason, ok: resp.ok !== false,
        };
      }
      const items = asList(f.items).map(normalizeLibraryItem);
      const stats = f.stats && typeof f.stats === 'object' ? f.stats : {};
      const counts = {};
      LIB_GROUP_KEYS.forEach((k) => { counts[k] = 0; });
      counts.all = items.length;
      items.forEach((it) => { if (counts[it.group] !== undefined) counts[it.group] += 1; });
      if (!items.length) {
        counts.all = Number(stats.total) || 0;
        counts['intl-official'] = Number(stats.intlOfficial) || 0;
        counts['cn-official'] = Number(stats.cnOfficial) || 0;
        counts.opensource = Number(stats.opensource) || 0;
        counts.method = Number(stats.method) || 0;
        counts.community = Number(stats.community) || 0;
      }
      const featuredIds = asList(f.featured).map(str).filter(Boolean);
      if (!featuredIds.length) items.forEach((it) => { if (it.featured) featuredIds.push(it.id); });
      const total = Number.isFinite(Number(stats.total)) && Number(stats.total) > 0 ? Number(stats.total) : items.length;
      return {
        feed: {
          date: str(f.date),
          fetchedAt: str(f.fetchedAt),
          ok: f.ok !== false,
          lastError: str(f.lastError),
          items,
          counts,
          total,
          newCount: Number(stats.new) || items.filter((x) => x.isNew).length,
          updatedCount: Number(stats.updated) || items.filter((x) => x.updated).length,
          featuredIds,
          warnings: asList(f.warnings)
            .map((w) => str(typeof w === 'string' ? w : (w && (w.message || w.reason || w.code))))
            .filter(Boolean),
          catalogUpdatedAt: str(f.catalogUpdatedAt),
        },
        today, stale: !!resp.stale, refreshing: !!resp.refreshing, code, reason, ok: resp.ok !== false,
      };
    }

    function LibraryView(props) {
      const p = props || {};
      const meta = p.meta;
      const [feed, setFeed] = useState(null);
      const [today, setToday] = useState(todayStr());
      const [stale, setStale] = useState(false);
      const [code, setCode] = useState('');
      const [reason, setReason] = useState('');
      const [loading, setLoading] = useState(true);
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState(null);
      const [group, setGroup] = useState('all');
      const [kind, setKind] = useState('all');
      const [stage, setStage] = useState('all');
      const [search, setSearch] = useState('');
      const [featuredOnly, setFeaturedOnly] = useState(false);
      const [sort, setSort] = useState('recommend');
      const alive = useRef(true);

      useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

      const applyResponse = useCallback((r) => {
        const nf = normalizeLibraryFeed(r || {});
        setToday(nf.today);
        setStale(nf.stale);
        setCode(nf.code);
        setReason(nf.reason);
        setFeed(nf.feed);
      }, []);

      const load = useCallback(async () => {
        setLoading(true);
        const r = await fdeGet('/library/feed');
        if (!alive.current) return;
        setLoading(false);
        applyResponse(r);
      }, [applyResponse]);

      useEffect(() => { load(); }, [load]);

      const doRefresh = async () => {
        if (busy || loading) return;
        setBusy(true);
        setMsg(null);
        const r = await fdePost('/library/refresh', { force: true });
        if (!alive.current) return;
        setBusy(false);
        applyResponse(r);
        if (r && r.ok !== false) setMsg({ kind: 'ok', text: t('libRefreshOk') });
        else setMsg({ kind: 'warn', text: t('libRefreshFail') + '：' + (str(r && r.reason) || t('unknown')) });
      };

      const items = feed ? feed.items : [];
      const counts = feed ? feed.counts : { all: 0 };
      const featuredSet = {};
      (feed ? feed.featuredIds : []).forEach((id) => { featuredSet[id] = true; });
      const featuredItems = feed
        ? feed.featuredIds.map((id) => items.find((it) => it.id === id)).filter(Boolean).slice(0, 6)
        : [];
      const stages = asList(meta && meta.stages);
      const kindKeys = [];
      items.forEach((it) => { if (kindKeys.indexOf(it.kind) === -1) kindKeys.push(it.kind); });
      kindKeys.sort();
      const kw = str(search).trim().toLowerCase();
      const filtered = items.filter((it) => {
        if (group !== 'all' && it.group !== group) return false;
        if (kind !== 'all' && it.kind !== kind) return false;
        if (stage !== 'all' && !(it.stages.indexOf('all') !== -1 || it.stages.indexOf(stage) !== -1)) return false;
        if (featuredOnly && !libIsFeatured(it, featuredSet)) return false;
        if (!kw) return true;
        const hay = [it.title, it.publisher, it.summary, it.why, it.repo, it.topics.join(' ')].join(' ').toLowerCase();
        return hay.indexOf(kw) !== -1;
      });
      const rankOf = (it) => (it.recommend === 'star' ? 3 : (it.recommend === 'recommend' ? 2 : (it.recommend === 'backup' ? 1 : 0)));
      const hotOf = (it) => it.stars || it.community.read || it.community.like || 0;
      const stageBreadth = (it) => (it.stages.indexOf('all') !== -1 ? stages.length : it.stages.length);
      const shown = filtered.slice().sort((a, b) => {
        if (sort === 'latest') {
          const d = libTimeValue(b.addedAt) - libTimeValue(a.addedAt);
          return d || libTimeValue(b.activeAt) - libTimeValue(a.activeAt);
        }
        if (sort === 'hot') {
          const d = hotOf(b) - hotOf(a);
          if (d) return d;
          const f = (libIsFeatured(b, featuredSet) ? 1 : 0) - (libIsFeatured(a, featuredSet) ? 1 : 0);
          return f || libTimeValue(b.addedAt) - libTimeValue(a.addedAt);
        }
        const ra = rankOf(b) - rankOf(a);
        if (ra) return ra;
        const fa = (libIsFeatured(b, featuredSet) ? 1 : 0) - (libIsFeatured(a, featuredSet) ? 1 : 0);
        if (fa) return fa;
        const ta = libTimeValue(b.addedAt) - libTimeValue(a.addedAt);
        if (ta) return ta;
        return stageBreadth(b) - stageBreadth(a);
      });

      const resetFilters = () => {
        setGroup('all'); setKind('all'); setStage('all');
        setSearch(''); setFeaturedOnly(false); setSort('recommend');
      };

      const refreshBtn = h(Btn, {
        small: true, kind: 'primary', onClick: doRefresh,
        busy: busy, disabled: busy || loading,
        ariaLabel: t('libRefreshAria'),
      }, busy ? t('libRefreshing') : t('libRefresh'));

      const groupSeg = () => h('div', { className: 'fde-seg fde-lib-groups', role: 'tablist', 'aria-label': t('libGroupLabel') },
        LIB_GROUP_KEYS.map((k) => h('button', {
          key: k,
          type: 'button',
          role: 'tab',
          'aria-selected': group === k ? 'true' : 'false',
          className: group === k ? 'on' : '',
          onClick: () => setGroup(k),
        }, libGroupLabel(k) + ' ' + (k === 'all' ? items.length : (counts[k] || 0)))));

      const toolbarNode = () => h('div', { className: 'fde-toolbar' },
        groupSeg(),
        h('select', {
          className: 'fde-select', style: { height: 30, fontSize: 13, maxWidth: 150 },
          value: kind, 'aria-label': t('libKindLabel'),
          onChange: (e) => setKind(e.target.value),
        },
          [{ value: 'all', label: t('libKindAll') }]
            .concat(kindKeys.map((k) => ({ value: k, label: libKindLabel(k) })))
            .map((o) => h('option', { key: o.value, value: o.value }, o.label))),
        h('select', {
          className: 'fde-select', style: { height: 30, fontSize: 13, maxWidth: 150 },
          value: stage, 'aria-label': t('libStageLabel'),
          onChange: (e) => setStage(e.target.value),
        },
          [{ value: 'all', label: t('libStageAll') }]
            .concat(stages.map((s) => ({ value: s.key, label: s.label || s.key })))
            .map((o) => h('option', { key: o.value, value: o.value }, o.label))),
        h('div', { className: 'fde-search' },
          h('span', { className: 'fde-search-icon', 'aria-hidden': 'true' }, '⌕'),
          h('input', {
            className: 'fde-input', type: 'search', value: search,
            placeholder: t('libSearchPh'), 'aria-label': t('libSearchPh'),
            onChange: (e) => setSearch(e.target.value),
          })),
        h(Checkbox, {
          checked: featuredOnly,
          label: t('libFeaturedOnly'),
          ariaLabel: t('libFeaturedOnly'),
          onChange: (v) => setFeaturedOnly(!!v),
        }),
        h('div', { className: 'fde-seg', role: 'tablist', 'aria-label': t('libSortLabel') },
          LIB_SORT_KEYS.map((k) => h('button', {
            key: k,
            type: 'button',
            role: 'tab',
            'aria-selected': sort === k ? 'true' : 'false',
            className: sort === k ? 'on' : '',
            onClick: () => setSort(k),
          }, libSortLabel(k)))));

      const authBadge = (it) => h('span', {
        className: 'fde-lib-auth fde-lib-auth-' + libAuthorityKey(it.authority).toLowerCase(),
        title: libAuthorityLabel(it.authority),
      }, libAuthorityKey(it.authority));

      const badgeRow = (it, compact) => h('div', { className: 'fde-lib-badges' },
        h('span', { className: 'fde-lib-group', title: t('libGroupLabel') }, libGroupLabel(it.group)),
        h('span', { className: 'fde-lib-kind' }, libKindLabel(it.kind)),
        authBadge(it),
        h('div', { className: 'fde-spacer' }),
        libIsFeatured(it, featuredSet) ? h(Chip, { tone: 'accent', children: t('libFeaturedBadge') }) : null,
        it.isNew ? h(Chip, { tone: 'ok', children: t('libNewTag') }) : null,
        it.updated ? h(Chip, { tone: 'warn', children: t('libUpdatedTag') }) : null);

      const titleNode = (it) => {
        const safe = isSafeUrl(it.url);
        if (!safe) return h('div', { className: 'fde-lib-title fde-lib-title-plain' }, it.title);
        return h('button', {
          type: 'button',
          className: 'fde-lib-title',
          title: t('libOpen') + '：' + it.title,
          'aria-label': t('libOpen') + '：' + it.title,
          onClick: () => openExternal(it.url),
        }, it.title);
      };

      const bylineNode = (it) => h('div', { className: 'fde-lib-byline' },
        h('span', null, it.publisher || t('unknown')),
        it.group === 'community' && it.community.publishedAt
          ? h('span', { className: 'fde-dim' }, '· ' + relTime(it.community.publishedAt))
          : null,
        it.verifiedAt ? h('span', { className: 'fde-dim' }, '· ' + t('libVerifiedAt') + ' ' + fmtDay(it.verifiedAt)) : null,
        libHost(it.url) ? h('span', { className: 'fde-dim' }, '· ' + libHost(it.url)) : null);

      const stageChips = (it) => h('div', { className: 'fde-lib-stages' },
        libStageLabels(it, meta).map((label, i) => h(Chip, { key: 'st-' + i, tone: 'muted', children: label })));

      const repoNode = (it) => {
        if (it.group !== 'opensource' && !it.repo) return null;
        return h('div', { className: 'fde-lib-repo' },
          h('span', { className: 'fde-num' }, t('libStarsPrefix') + Number(it.stars || 0).toLocaleString('zh-CN')),
          it.license ? h('span', null, t('libLicenseLabel') + ' ' + it.license) : null,
          it.pushedAt ? h('span', null, t('libPushedLabel') + ' ' + fmtDay(it.pushedAt)) : null);
      };

      const cardNode = (it) => {
        const safe = isSafeUrl(it.url);
        return h('div', { key: it.id, className: 'fde-lib-card' },
          badgeRow(it),
          titleNode(it),
          bylineNode(it),
          it.summary ? h('div', { className: 'fde-lib-summary' }, it.summary) : null,
          it.why ? h('div', { className: 'fde-lib-why' }, t('libWhyPrefix') + it.why) : null,
          it.note ? h('div', { className: 'fde-hint' }, it.note) : null,
          repoNode(it),
          stageChips(it),
          h('div', { className: 'fde-lib-foot' },
            safe
              ? h(Btn, { small: true, onClick: () => openExternal(it.url), ariaLabel: t('libOpen') }, t('libOpen'))
              : h('span', { className: 'fde-hint' }, t('libNoUrl'))));
      };

      const featuredCard = (it) => {
        const safe = isSafeUrl(it.url);
        return h('div', { key: 'feat-' + it.id, className: 'fde-lib-featured-card' },
          badgeRow(it, true),
          titleNode(it),
          bylineNode(it),
          it.why || it.summary ? h('div', { className: 'fde-lib-summary' }, it.why || it.summary) : null,
          stageChips(it),
          h('div', { className: 'fde-lib-foot' },
            safe
              ? h(Btn, { small: true, onClick: () => openExternal(it.url), ariaLabel: t('libOpen') }, t('libOpen'))
              : h('span', { className: 'fde-hint' }, t('libNoUrl'))));
      };

      const topCard = h('div', { className: 'fde-card' },
        Section({
          title: t('libTitle'),
          extra: h('span', { className: 'fde-hint' }, t('libSubtitle')),
          children: [
            loading && !feed ? h(Loading, { key: 'loading', text: t('libLoading') }) : null,
            msg ? h(MsgLine, { key: 'msg', kind: msg.kind, text: msg.text, onClose: () => setMsg(null) }) : null,
            code === 'UNAVAILABLE'
              ? h(ErrorLine, {
                key: 'catalogMissing',
                title: t('libCatalogMissing'),
                text: t('libCatalogMissingBody') + (reason ? '（' + reason + '）' : ''),
                onRetry: doRefresh,
              })
              : null,
            feed ? h('div', { key: 'info', className: 'fde-lib-info' },
              h('div', { className: 'fde-row' },
                h('span', { className: 'fde-chip accent' }, feed.date || t('unknown')),
                h('span', { className: 'fde-hint' }, t('libUpdated') + ' ' + (libUpdatedText(feed.fetchedAt, today) || '—')),
                h('span', { className: 'fde-hint' }, t('libTotalPrefix') + feed.total + t('libTotalSuffix')),
                feed.newCount ? h('span', { className: 'fde-chip ok' }, t('libNewTag') + ' ' + feed.newCount) : null,
                feed.updatedCount ? h('span', { className: 'fde-chip warn' }, t('libUpdatedTag') + ' ' + feed.updatedCount) : null,
                h('div', { className: 'fde-spacer' }),
                refreshBtn),
              h('div', { className: 'fde-row tight' },
                LIB_GROUP_KEYS.filter((k) => k !== 'all').map((k) => (
                  h('span', { key: 'gc-' + k, className: 'fde-chip muted' },
                    libGroupLabel(k) + ' ' + (counts[k] || 0)))))) : null,
            !feed && !loading && code !== 'UNAVAILABLE'
              ? h(Empty, {
                key: 'emptyCache',
                mark: '◇',
                title: t('libEmptyTitle'),
                body: t('libEmptyBody'),
                actions: h('div', { className: 'fde-row', style: { justifyContent: 'center', marginTop: 8 } }, refreshBtn),
              })
              : null,
            feed && !feed.ok
              ? h(MsgLine, {
                key: 'lastFail',
                kind: 'warn',
                text: t('libStaleWarn') + (feed.lastError ? '：' + feed.lastError : '')
                  + '（' + t('libLastOk') + ' ' + (libUpdatedText(feed.fetchedAt, today) || '—') + '）',
              })
              : null,
            feed && stale
              ? h(MsgLine, { key: 'stale', kind: 'warn', text: t('libStaleHint') })
              : null,
            feed && feed.warnings.length
              ? h(MsgLine, { key: 'warn', kind: 'warn', text: feed.warnings.join('；') })
              : null,
            code === 'UNAVAILABLE' && feed
              ? h(MsgLine, { key: 'catalogOld', kind: 'warn', text: t('libStaleWarn') + '（' + (libUpdatedText(feed.fetchedAt, today) || '—') + '）' })
              : null,
          ],
        }));

      const featuredBlock = feed && featuredItems.length
        ? h('div', { className: 'fde-card' },
          Section({
            title: '★ ' + t('libFeaturedTitle'),
            extra: h('span', { className: 'fde-hint' }, t('libFeaturedHint')),
            children: h('div', { className: 'fde-lib-featured' }, featuredItems.map(featuredCard)),
          }))
        : null;

      let listCard = null;
      if (feed) {
        const countNode = h('div', { className: 'fde-hint' },
          t('libTotalPrefix') + shown.length + ' / ' + items.length + t('libTotalSuffix'));
        let listBody;
        if (!items.length) {
          listBody = h(Empty, { mark: '◇', title: t('libEmptyItems'), body: t('libEmptyItemsBody') });
        } else if (!shown.length) {
          listBody = h(Empty, {
            mark: '⌕',
            title: t('libFilterEmpty'),
            body: t('libFilterEmptyHint'),
            actions: h('div', { className: 'fde-row', style: { justifyContent: 'center', marginTop: 8 } },
              h(Btn, { small: true, onClick: resetFilters }, t('libResetFilters'))),
          });
        } else {
          listBody = h('div', { className: 'fde-lib-grid' }, shown.map(cardNode));
        }
        listCard = h('div', { className: 'fde-card' },
          toolbarNode(),
          countNode,
          listBody,
          h('div', { className: 'fde-hint', style: { marginTop: 8 } }, t('libFootnote')));
      }

      return h('div', { className: 'fde-view fde-view-fill' }, topCard, featuredBlock, listCard);
    }

    /* ============================================================
     * 十一、流程视图（第 4 页签，spec §20.5）
     * 数据：GET /fde/meta 的 stages[].playbook 与 gates（宿主 schema 派生）；
     * 面板只读展示，不硬编码阶段数与顺序。方法/模板 chips 跳「方法」页并
     * 直接打开文件；技能/工具 chips 展开「在会话中这样用」示例并复制；
     * 资料库 chips 跳「资料库」；底部是阶段 × 工具只读矩阵。
     * ============================================================ */
    const PROCESS_TOOL_KINDS = ['skill', 'method', 'template', 'tool', 'library'];

    function processToolKindLabel(kind) {
      const map = {
        skill: t('processToolSkill'), method: t('processToolMethod'), template: t('processToolTemplate'),
        tool: t('processToolTool'), library: t('processToolLibrary'),
      };
      const k = str(kind) || 'tool';
      return map[k] || k;
    }

    function normalizePlaybookTool(raw, idx) {
      if (typeof raw === 'string') {
        return { kind: 'tool', name: raw, label: raw, key: 'tool:' + raw };
      }
      const o = raw && typeof raw === 'object' ? raw : {};
      const kind = PROCESS_TOOL_KINDS.indexOf(str(o.kind)) !== -1 ? str(o.kind) : 'tool';
      const name = str(pick(o.name, o.label));
      const label = str(pick(o.label, o.name, name)) || ('item-' + idx);
      return { kind, name, label, key: kind + ':' + (name || label) };
    }

    function normalizePlaybook(raw) {
      const o = raw && typeof raw === 'object' ? raw : null;
      if (!o) return null;
      return {
        goal: str(o.goal),
        inputs: asList(o.inputs).map(str).filter(Boolean),
        activities: asList(o.activities).map(str).filter(Boolean),
        outputs: asList(o.outputs).map(str).filter(Boolean),
        tools: asList(o.tools).map(normalizePlaybookTool).filter((x) => x.name || x.label),
        pitfalls: asList(o.pitfalls).map(str).filter(Boolean),
      };
    }

    function ProcessView(props) {
      const p = props || {};
      const meta = p.meta;
      const board = p.board || {};
      const stages = asList(meta && meta.stages);
      const [activeKey, setActiveKey] = useState(stages[0] ? stages[0].key : '');
      const [openTool, setOpenTool] = useState('');
      const [copied, setCopied] = useState('');
      const alive = useRef(true);

      useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

      const counts = {};
      stages.forEach((s) => { counts[s.key] = 0; });
      asList(board.engagements).forEach((eng) => {
        const k = eng && eng.stage;
        if (k && counts[k] !== undefined) counts[k] += 1;
      });
      const hasPlaybook = stages.some((s) => s && s.playbook);
      const current = stageOf(meta, activeKey) || stages[0] || null;
      const playbook = current ? current.playbook : null;
      const gate = current ? gateOfStage(meta, current.key) : null;

      const copyExample = async (text, key) => {
        let ok = false;
        try { if (typeof p.copyText === 'function') ok = !!(await p.copyText(text)); } catch (e) { ok = false; }
        if (!ok) {
          try {
            if (typeof navigator !== 'undefined' && navigator.clipboard) {
              await navigator.clipboard.writeText(text);
              ok = true;
            }
          } catch (e) { ok = false; }
        }
        if (ok && alive.current) {
          setCopied(key);
          setTimeout(() => { if (alive.current) setCopied(''); }, 1800);
        }
      };

      const toolExample = (tool) => {
        if (tool.kind === 'skill') return t('processSkillUse') + tool.name + t('processSkillUseEnd');
        return t('processToolUse') + tool.name + t('processToolUseEnd');
      };

      const clickTool = (tool) => {
        if (tool.kind === 'method' || tool.kind === 'template') {
          if (typeof p.onOpenMethod === 'function') p.onOpenMethod(tool.name || tool.label, tool.kind);
          return;
        }
        if (tool.kind === 'library') {
          if (typeof p.onOpenLibrary === 'function') p.onOpenLibrary();
          return;
        }
        setOpenTool(openTool === tool.key ? '' : tool.key);
      };

      const stepNode = (s) => {
        const g = gateOfStage(meta, s.key);
        const gateCount = asList(g.auto).length + asList(g.manual).length;
        const on = current && s.key === current.key;
        const title = (s.label || s.key) + '：' + (counts[s.key] || 0) + t('processClientCountSuffix')
          + (g.label ? '；' + t('processGate') + ' ' + g.label : '');
        return h('button', {
          key: s.key,
          type: 'button',
          role: 'tab',
          'aria-selected': on ? 'true' : 'false',
          className: 'fde-flow-step' + (on ? ' on' : ''),
          title,
          onClick: () => setActiveKey(s.key),
        },
          h('div', { className: 'fde-flow-step-top' },
            h('span', { className: 'fde-flow-num' }, String(s.order || '')),
            h('span', {
              className: 'fde-flow-gate-dot ' + (gateCount ? 'ok' : 'warn'),
              title: g.label + '：' + gateCount + t('processGateItemSuffix'),
              'aria-hidden': 'true',
            })),
          h('div', { className: 'fde-flow-name' }, s.label || s.key),
          h('div', { className: 'fde-flow-count' }, (counts[s.key] || 0) + t('processClientCountSuffix')));
      };

      const listBlock = (title, list, wide) => h('div', {
        key: title,
        className: 'fde-flow-block' + (wide ? ' fde-flow-wide' : ''),
      },
        h('div', { className: 'fde-flow-block-title' }, title),
        list.length
          ? h('ul', { className: 'fde-flow-list' }, list.map((x, i) => h('li', { key: 'li-' + i }, x)))
          : h('div', { className: 'fde-hint' }, t('empty')));

      const detailCard = current ? h('div', { className: 'fde-card' },
        Section({
          title: (current.order ? current.order + ' · ' : '') + (current.label || current.key),
          extra: current.definition ? h('span', { className: 'fde-hint' }, current.definition) : null,
          children: [
            playbook && playbook.goal
              ? h('div', { key: 'goal', className: 'fde-flow-goal' },
                h('span', { className: 'fde-flow-goal-label' }, t('processGoal')),
                h('span', null, playbook.goal))
              : null,
            playbook
              ? h('div', { key: 'flow', className: 'fde-flow-detail' },
                listBlock(t('processInputs'), playbook.inputs),
                listBlock(t('processActivities'), playbook.activities),
                listBlock(t('processOutputs'), playbook.outputs),
                listBlock(t('processPitfalls'), playbook.pitfalls),
                h('div', { key: 'tools', className: 'fde-flow-block fde-flow-wide' },
                  h('div', { className: 'fde-flow-block-title' }, t('processTools')),
                  h('div', { className: 'fde-flow-tools' },
                    PROCESS_TOOL_KINDS.map((kind) => {
                      const group = playbook.tools.filter((x) => x.kind === kind);
                      if (!group.length) return null;
                      return h('div', { key: 'kind-' + kind, className: 'fde-flow-tool-group' },
                        h('div', { className: 'fde-flow-tool-kind' }, processToolKindLabel(kind)),
                        group.map((tool) => h('div', { key: tool.key, className: 'fde-flow-tool-item' },
                          h('button', {
                            type: 'button',
                            className: 'fde-flow-tool' + (openTool === tool.key ? ' on' : ''),
                            title: tool.kind === 'method' || tool.kind === 'template'
                              ? t('processOpenMethod') + '：' + tool.label
                              : (tool.kind === 'library' ? t('processOpenLibrary') : t('processHowTo')),
                            onClick: () => clickTool(tool),
                          }, tool.label),
                          openTool === tool.key
                            ? h('div', { className: 'fde-flow-example' },
                              h('div', { className: 'fde-flow-example-label' }, t('processHowTo')),
                              h('div', { className: 'fde-flow-example-text' }, toolExample(tool)),
                              h(Btn, {
                                small: true,
                                onClick: () => copyExample(toolExample(tool), tool.key),
                              }, copied === tool.key ? t('processCopied') : t('processCopy')))
                            : null)));
                    }))),
                h('div', { key: 'gate', className: 'fde-flow-block fde-flow-wide' },
                  h('div', { className: 'fde-flow-block-title' },
                    t('processGate') + (gate && gate.label ? '（' + gate.label + '）' : '')),
                  gate && (asList(gate.auto).length || asList(gate.manual).length)
                    ? h('div', { className: 'fde-flow-gate-cols' },
                      h('div', null,
                        h('div', { className: 'fde-flow-sub' }, t('processGateAuto') + '（' + asList(gate.auto).length + '）'),
                        asList(gate.auto).length
                          ? h('ul', { className: 'fde-flow-list' }, asList(gate.auto).map((x, i) => h('li', { key: 'ga-' + i }, x.label || x.key)))
                          : h('div', { className: 'fde-hint' }, t('empty'))),
                      h('div', null,
                        h('div', { className: 'fde-flow-sub' }, t('processGateManual') + '（' + asList(gate.manual).length + '）'),
                        asList(gate.manual).length
                          ? h('ul', { className: 'fde-flow-list' }, asList(gate.manual).map((x, i) => h('li', { key: 'gm-' + i }, x.label || x.key)))
                          : h('div', { className: 'fde-hint' }, t('empty'))))
                    : h('div', { className: 'fde-hint' }, t('processNoGate')))
              )
              : h(MsgLine, { key: 'noPlaybook', kind: 'warn', text: t('processNoPlaybook') }),
          ],
        })) : null;

      const toolCols = (() => {
        const map = {};
        const list = [];
        stages.forEach((s) => {
          asList(s.playbook && s.playbook.tools).forEach((tool) => {
            if (!map[tool.key]) { map[tool.key] = tool; list.push(tool); }
          });
        });
        return list;
      })();

      const matrixCard = h('div', { className: 'fde-card' },
        Section({
          title: t('processMatrixTitle'),
          extra: h('span', { className: 'fde-hint' }, t('processMatrixHint')),
          children: toolCols.length
            ? h('div', { className: 'fde-matrix-wrap' },
              h('table', { className: 'fde-matrix' },
                h('thead', null,
                  h('tr', null,
                    h('th', { key: 'stage-col' }, t('processColStage')),
                    toolCols.map((tool) => h('th', {
                      key: 'tc-' + tool.key,
                      title: processToolKindLabel(tool.kind) + '：' + tool.name,
                    }, tool.label)))),
                h('tbody', null,
                  stages.map((s) => h('tr', { key: 'row-' + s.key },
                    h('th', { key: 'row-h', scope: 'row' }, (s.order ? s.order + '. ' : '') + (s.label || s.key)),
                    toolCols.map((tool) => {
                      const has = asList(s.playbook && s.playbook.tools).some((x) => x.key === tool.key);
                      return h('td', { key: 'cell-' + tool.key, className: has ? 'on' : '' }, has ? '✓' : '');
                    }))))))
            : h('div', { className: 'fde-hint' }, t('processNoPlaybook')),
        }));

      return h('div', { className: 'fde-view fde-view-fill' },
        !hasPlaybook ? h(MsgLine, { kind: 'warn', text: t('processNoPlaybook') }) : null,
        h('div', { className: 'fde-card' },
          Section({
            title: t('processTitle'),
            extra: h('span', { className: 'fde-hint' }, t('processSubtitle')),
            children: [
              stages.length
                ? h('div', { className: 'fde-flow', role: 'tablist', 'aria-label': t('processTitle') }, stages.map(stepNode))
                : h(Empty, { key: 'noMeta', mark: '▤', title: t('processNoMeta'), body: t('processNoMetaBody') }),
            ],
          })),
        detailCard,
        matrixCard);
    }

    /* ============================================================
     * 十二、方法视图 / 设置视图
     * 方法：旧 methods/reference/templates 点开即读 + FDE 技能清单；
     *       支持 initialName/initialSeq：流程页的 method/template chips
     *       跳转过来时直接打开对应文件。
     * 设置：自主性 / 停滞天数 / WIP / 数据源开关 / 健康检查 / 重启提示。
     * ============================================================ */
    function MethodsView(props) {
      const p = props || {};
      const meta = p.meta;
      const [items, setItems] = useState(null);
      const [body, setBody] = useState(null);
      const [err, setErr] = useState('');
      const [loading, setLoading] = useState(false);
      const alive = useRef(true);

      useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

      const load = useCallback(async () => {
        setLoading(true); setErr('');
        const r = await getJSON(API + '/methods');
        if (!alive.current) return;
        setLoading(false);
        if (r && r.ok !== false) setItems(asList(r.items));
        else { setItems([]); setErr((r && r.reason) || t('methodsEmpty')); }
      }, []);

      useEffect(() => { load(); }, [load]);

      const read = async (nm) => {
        setLoading(true); setErr('');
        const r = await getJSON(API + '/methods?name=' + encodeURIComponent(str(nm).replace(/\.md$/, '')));
        if (!alive.current) return;
        setLoading(false);
        if (r && r.ok !== false) setBody({ name: str(r.file || nm), body: str(r.body) });
        else { setBody(null); setErr((r && r.reason) || t('methodsReadFail')); }
      };

      /* 流程页 chips 跳转：initialName 变化（initialSeq 递增）时直接打开文件 */
      const initialName = str(p.initialName);
      const initialSeq = typeof p.initialSeq === 'number' ? p.initialSeq : 0;
      useEffect(() => {
        if (initialName) read(initialName);
      }, [initialName, initialSeq]);

      const section = p.section === 'skills' ? 'skills' : 'methods';
      const groups = section === 'skills'
        ? [{ kind: 'template', label: '模板' }]
        : [{ kind: 'method', label: '方法' }, { kind: 'reference', label: '参考' }];
      const list = items || [];
      const skills = asList(meta && meta.skills);

      return h('div', { className: 'fde-view' },
        err ? h(ErrorLine, { title: t('loadFail'), text: err, onRetry: () => (body ? read(body.name) : load()) }) : null,
        loading && !list.length ? h(Loading, {}) : null,
        body
          ? h('div', { className: 'fde-card' },
            h('div', { className: 'fde-row', style: { marginBottom: 8 } },
              h(Btn, { small: true, onClick: () => setBody(null) }, t('back')),
              h('span', { className: 'fde-subtitle' }, body.name)),
            h('pre', { className: 'fde-pre' }, body.body))
          : (list.length
            ? h('div', { className: 'fde-stack' },
              groups.map((g) => {
                const entries = list.filter((m) => str(m.kind) === g.kind || (g.kind === 'method' && str(m.kind) === 'methods'));
                if (!entries.length) return null;
                return h('div', { key: g.kind, className: 'fde-card' },
                  Section({
                    title: g.label + '（' + entries.length + '）',
                    children: h('div', { className: 'fde-mth' }, entries.map((m) => h('button', {
                      key: str(m.kind) + '-' + str(m.name),
                      type: 'button',
                      onClick: () => read(m.name),
                      title: '点开即读',
                    }, str(m.name).replace(/\.md$/, '')))),
                  }));
              }))
            : h(Empty, { mark: '▤', title: t('methodsEmpty') })),
        section === 'skills'
          ? h('div', { className: 'fde-card' },
            Section({
              title: t('methodsSkills') + (skills.length ? '（' + skills.length + '）' : ''),
              children: skills.length
                ? h('div', { className: 'fde-stack' }, skills.map((sk) => h('div', { key: sk.name, className: 'fde-skill' },
                  h('div', { className: 'fde-skill-name' }, sk.name),
                  h('div', { className: 'fde-skill-desc' }, sk.description || h('span', { className: 'fde-dim' }, '（无描述）')))))
                : h('div', { className: 'fde-hint' }, t('skillsEmpty')),
              extra: h('span', { className: 'fde-hint' }, t('methodsSkillsHint')),
            }))
          : null);
    }

    function SettingsView(props) {
      const p = props || {};
      const meta = p.meta;
      const board = p.board || {};
      const settings = board.settings || {};
      const defaults = (meta && meta.settingsDefaults) || {};
      const [autonomy, setAutonomy] = useState(str(settings.autonomy || defaults.autonomy || 'observe'));
      const [stallDays, setStallDays] = useState(String(pick(settings.stallDays, defaults.stallDays, 14)));
      const [wip, setWip] = useState(String(pick(settings.wipLimits && settings.wipLimits.doing, defaults.wipLimits && defaults.wipLimits.doing, 5)));
      const [sources, setSources] = useState(normalizeSourceSettings(settings.sources || defaults.sources));
      const [saving, setSaving] = useState(false);
      const [msg, setMsg] = useState(null);
      const [health, setHealth] = useState(null);
      const [healthErr, setHealthErr] = useState('');
      const [healthLoading, setHealthLoading] = useState(false);
      /* 生财情报授权（§2.8）：token 只进请求体，不落组件外、不回显 */
      const [scysAuth, setScysAuth] = useState(null);
      const [scysErr, setScysErr] = useState('');
      const [scysLoading, setScysLoading] = useState(false);
      const [scysInput, setScysInput] = useState('');
      const [scysMsg, setScysMsg] = useState(null);
      const [scysBusy, setScysBusy] = useState('');
      const [scysConfirmClear, setScysConfirmClear] = useState(false);
      const alive = useRef(true);

      useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

      /* board 刷新后同步服务端值（用户尚未编辑时以服务端为准） */
      useEffect(() => {
        setAutonomy(str(settings.autonomy || defaults.autonomy || 'observe'));
        setStallDays(String(pick(settings.stallDays, defaults.stallDays, 14)));
        setWip(String(pick(settings.wipLimits && settings.wipLimits.doing, defaults.wipLimits && defaults.wipLimits.doing, 5)));
        setSources(normalizeSourceSettings(settings.sources || defaults.sources));
      }, [board.updatedAt]);

      /* 生财情报授权：GET /fde/scys/auth 读三路授权状态。
         宿主未提供路由（未重启/旧宿主）时只降级提示，设置页其它功能不受影响（§2.8）。 */
      const loadScysAuth = useCallback(async () => {
        setScysLoading(true);
        const r = await fdeGet('/scys/auth');
        if (!alive.current) return;
        setScysLoading(false);
        if (r && r.ok !== false && r.auth) { setScysAuth(r.auth); setScysErr(''); }
        else { setScysAuth(null); setScysErr((r && r.reason) || '授权接口不可用'); }
      }, []);
      useEffect(() => { loadScysAuth(); }, [loadScysAuth]);

      const save = async () => {
        const patch = {
          autonomy,
          stallDays: Number(stallDays) || 0,
          wipLimits: { doing: Number(wip) || 0 },
          sources,
        };
        setSaving(true); setMsg(null);
        const r = await fdePost('/settings', { patch });
        if (!alive.current) return;
        setSaving(false);
        if (r && r.ok !== false) {
          setMsg({ kind: 'ok', text: t('settingsSaved') });
          if (p.onRefresh) await p.onRefresh();
        } else {
          setMsg({ kind: 'err', text: (r && r.reason) || t('actionFail') });
        }
      };

      const runHealth = async () => {
        setHealthLoading(true); setHealthErr('');
        const r = await fdeGet('/health');
        if (!alive.current) return;
        setHealthLoading(false);
        if (r && r.ok !== false && Array.isArray(r.checks)) setHealth(r.checks);
        else if (r && Array.isArray(r.checks)) setHealth(r.checks);
        else setHealthErr((r && r.reason) || t('loadFail'));
      };

      /* 保存链接授权：URL 走 {url}（宿主解析 token 参数），否则按 access_token 走 {token} */
      const saveScysAuth = async () => {
        const v = str(scysInput).trim();
        if (!v) { setScysMsg({ kind: 'warn', text: '请先粘贴授权链接或 access_token' }); return; }
        setScysBusy('save'); setScysMsg(null);
        const looksLikeUrl = /^https?:\/\//i.test(v) || /[?&#](access_)?token=/.test(v);
        const r = await fdePost('/scys/auth', looksLikeUrl ? { url: v } : { token: v });
        if (!alive.current) return;
        setScysBusy('');
        if (r && r.ok !== false && r.auth) {
          setScysAuth(r.auth);
          setScysInput('');
          setScysErr('');
          setScysMsg({ kind: 'ok', text: '授权已保存（仅写入本机 research/.fde/scys-auth.json）' });
        } else {
          setScysMsg({ kind: 'err', text: (r && r.reason) || '保存授权失败' });
        }
      };
      const clearScysAuth = async () => {
        setScysBusy('clear'); setScysMsg(null);
        const r = await fdePost('/scys/auth', { clear: true });
        if (!alive.current) return;
        setScysBusy('');
        setScysConfirmClear(false);
        if (r && r.ok !== false) {
          setScysAuth((r && r.auth) || null);
          setScysErr('');
          setScysMsg({ kind: 'ok', text: (r && r.removed === false) ? '本机没有链接授权，未做改动' : '已清除链接授权' });
        } else {
          setScysMsg({ kind: 'err', text: (r && r.reason) || '清除授权失败' });
        }
      };

      const modes = (meta && meta.autonomyModes && meta.autonomyModes.length)
        ? meta.autonomyModes
        : Object.keys(AUTONOMY_FALLBACK).map((k) => ({ key: k, label: AUTONOMY_FALLBACK[k].label, desc: AUTONOMY_FALLBACK[k].desc }));
      const allModes = modes.concat(
        Object.keys(AUTONOMY_FALLBACK).filter((k) => !modes.some((m) => m.key === k))
          .map((k) => ({ key: k, label: AUTONOMY_FALLBACK[k].label, desc: AUTONOMY_FALLBACK[k].desc }))
      );
      const sourceDefs = [
        ['folderWatch', '目录监听', '扫描 research/ 目录变化'],
        ['briefOnOpen', '打开即出简报', '打开面板时生成今日简报'],
        ['bidWatch', t('bidSettingsLabel'), t('bidSettingsDesc')],
      ];
      const bidInfo = p.bidStats || normalizeBoardBidStats(board);
      const bidStatusText = bidInfo && bidInfo.available
        ? '索引 ' + (bidInfo.records === null ? '—' : bidInfo.records) + ' 条 · 区间 ' + bidRangeText(bidInfo.dateRange)
        : t('bidNotReady');
      const bidStatusChip = Chip({
        tone: bidInfo && bidInfo.available ? 'ok' : 'warn',
        children: bidInfo && bidInfo.available ? t('bidServiceReady') : t('bidServiceNotReady'),
      });
      const healthBadge = (status) => {
        const s = str(status || '').toLowerCase();
        if (s === 'ok' || s === 'pass' || s === 'warn' || s === 'fail') {
          const tone = s === 'ok' || s === 'pass' ? 'ok' : (s === 'fail' ? 'danger' : 'warn');
          return Chip({ tone, children: s === 'ok' || s === 'pass' ? '通过' : (s === 'fail' ? '失败' : '警告') });
        }
        return Chip({ tone: 'muted', children: str(status) || '—' });
      };

      return h('div', { className: 'fde-view' },
        msg ? h(MsgLine, { kind: msg.kind, text: msg.text, onClose: () => setMsg(null) }) : null,
        h('div', { className: 'fde-card' },
          Section({
            title: t('settingsAutonomy'),
            children: [
              h('div', { className: 'fde-hint', style: { marginBottom: 6 } }, t('settingsAutonomyDesc')),
              h('div', { role: 'radiogroup', 'aria-label': t('settingsAutonomy'), style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                allModes.map((m) => h('label', {
                  key: m.key,
                  className: 'fde-check',
                  style: {
                    padding: '8px 10px', borderRadius: 'var(--dsw-radius-sm,8px)', border: (autonomy === m.key ? '1px' : '0.5px') + ' solid ' + (autonomy === m.key ? 'var(--fde-accent)' : 'var(--fde-border)'),
                    background: autonomy === m.key ? 'color-mix(in srgb,var(--fde-accent) 8%,transparent)' : 'var(--fde-surface-2)',
                  },
                },
                  h('input', {
                    type: 'radio', name: 'fde-autonomy', checked: autonomy === m.key,
                    'aria-label': m.label,
                    onChange: () => setAutonomy(m.key),
                  }),
                  h('div', null,
                    h('div', { style: { fontWeight: 600 } }, m.label),
                    h('div', { className: 'fde-hint' }, m.desc || (AUTONOMY_FALLBACK[m.key] && AUTONOMY_FALLBACK[m.key].desc) || ''))))),
              h('div', { className: 'fde-hint', style: { marginTop: 8 } }, t('settingsRedLines')),
              h('ul', { className: 'fde-redline' }, redLinesOf(meta).map((x, i) => h('li', { key: 'rl-' + i }, x))),
            ],
          })),
        h('div', { className: 'fde-card' },
          Section({
            title: '节奏与上限',
            children: [
              h('div', { className: 'fde-set-row' },
                h('div', { className: 'fde-set-main' },
                  h('div', { className: 'fde-set-name' }, t('settingsStall')),
                  h('div', { className: 'fde-set-desc' }, t('settingsStallDesc'))),
                h('div', { className: 'fde-set-ctl' },
                  h(TextInput, {
                    type: 'number', value: stallDays, ariaLabel: t('settingsStall'), style: { width: 96 },
                    onChange: (e) => setStallDays(e.target.value),
                  }),
                  h('span', { className: 'fde-hint' }, '天'))),
              h('div', { className: 'fde-set-row' },
                h('div', { className: 'fde-set-main' },
                  h('div', { className: 'fde-set-name' }, t('settingsWip')),
                  h('div', { className: 'fde-set-desc' }, t('settingsWipDesc'))),
                h('div', { className: 'fde-set-ctl' },
                  h(TextInput, {
                    type: 'number', value: wip, ariaLabel: t('settingsWip'), style: { width: 96 },
                    onChange: (e) => setWip(e.target.value),
                  }))),
              h('div', { className: 'fde-set-row' },
                h('div', { className: 'fde-set-main' },
                  h('div', { className: 'fde-set-name' }, t('settingsSources')),
                  h('div', { className: 'fde-set-desc' }, '默认只读；关闭后对应规则不再生成建议。')),
                h('div', { className: 'fde-set-ctl', style: { flexDirection: 'column', alignItems: 'flex-start' } },
                  sourceDefs.map(([key, label, desc]) => h(Checkbox, {
                    key,
                    checked: !!sources[key],
                    label,
                    title: desc,
                    onChange: (v) => setSources(Object.assign({}, sources, { [key]: v })),
                  })))),
              h('div', { className: 'fde-set-row' },
                h('div', { className: 'fde-set-main' },
                  h('div', { className: 'fde-set-name' }, t('bidServiceStatus')),
                  h('div', { className: 'fde-set-desc' }, bidStatusText)),
                h('div', { className: 'fde-set-ctl' }, bidStatusChip)),
              h('div', { className: 'fde-row', style: { marginTop: 10 } },
                h(Btn, { kind: 'primary', onClick: save, busy: saving }, saving ? t('saving') : t('settingsSave')),
                h('span', { className: 'fde-hint' }, '设置写入 research/.fde/board.json（宿主会先备份）。')),
            ],
          })),
        /* 生财情报授权（§2.8 / §5）：链接授权 / 环境变量 / 兼容文件三路状态 + 保存/清除。
           宿主未提供路由时 scysErr 给出降级提示，不白屏。 */
        h('div', { className: 'fde-card' },
          Section({
            title: '生财情报授权',
            extra: scysAuth && scysAuth.available
              ? Chip({ tone: 'ok', children: scysSourceText(scysAuth.source) })
              : Chip({ tone: 'warn', children: scysAuth ? scysSourceText(scysAuth.source) : '未授权' }),
            actions: h(Btn, { small: true, onClick: loadScysAuth, busy: scysLoading }, scysLoading ? '读取中…' : '刷新状态'),
            children: [
              scysErr
                ? h(MsgLine, {
                  key: 'scys-err', kind: 'warn',
                  text: '授权接口暂不可用（宿主重启后生效，不影响其它功能）：' + scysErr,
                })
                : null,
              h('div', { key: 'scys-status', className: 'fde-set-row' },
                h('div', { className: 'fde-set-main' },
                  h('div', { className: 'fde-set-name' }, '当前来源'),
                  h('div', { className: 'fde-set-desc' },
                    scysAuth ? scysSourceText(scysAuth.source) : '未授权',
                    scysAuth && scysAuth.source === 'compat'
                      ? '：读 ~/.dsh/mcp/scys-mcp/tokens.json（DSH 官方契约之外，建议改用链接授权）'
                      : '',
                    scysAuth && scysAuth.expiresAt ? ' · 过期时间 ' + fmtDateTime(scysAuth.expiresAt) : '')),
                h('div', { className: 'fde-set-ctl' },
                  scysAuth && scysAuth.available
                    ? Chip({ tone: 'ok', children: '可用' })
                    : Chip({ tone: 'warn', children: '未授权' }))),
              h(Field, { key: 'scys-input', label: '粘贴授权链接或 access_token' },
                h(TextArea, {
                  value: scysInput,
                  rows: 2,
                  placeholder: '粘贴授权链接或 access_token（保存后不回显）',
                  ariaLabel: '生财情报授权',
                  onChange: (e) => { setScysMsg(null); setScysInput(e.target.value); },
                })),
              h('div', { key: 'scys-hint', className: 'fde-hint' },
                'token 只保存在本机 research/.fde/scys-auth.json，不上传；也可用环境变量 FDE_SCYS_TOKEN。'),
              scysMsg
                ? h(MsgLine, { key: 'scys-msg', kind: scysMsg.kind, text: scysMsg.text, onClose: () => setScysMsg(null) })
                : null,
              h('div', { key: 'scys-actions', className: 'fde-row' },
                h(Btn, { kind: 'primary', busy: scysBusy === 'save', onClick: saveScysAuth }, scysBusy === 'save' ? '保存中…' : '保存授权'),
                scysConfirmClear
                  ? h('span', { className: 'fde-row tight' },
                    h(Btn, { small: true, kind: 'danger', busy: scysBusy === 'clear', onClick: clearScysAuth }, '确认清除'),
                    h(Btn, { small: true, onClick: () => setScysConfirmClear(false) }, t('cancel')))
                  : h(Btn, { small: true, kind: 'danger', onClick: () => setScysConfirmClear(true) }, '清除授权'),
                h('a', {
                  className: 'fde-link', href: '#scys-auth',
                  title: '授权说明见 README「生财情报授权」一节',
                }, '打开授权说明')),
            ],
          })),
        h('div', { className: 'fde-card' },
          Section({
            title: t('demoCardTitle'),
            extra: Chip({
              tone: p.demo && p.demo.active ? 'on' : 'muted',
              children: p.demo && p.demo.active ? t('demoStatusOn') : t('demoStatusOff'),
            }),
            children: [
              h('div', { className: 'fde-set-row' },
                h('div', { className: 'fde-set-main' },
                  h('div', { className: 'fde-set-desc' }, t('demoCardDesc')),
                  p.demo && p.demo.active
                    ? h('div', { className: 'fde-hint' }, '当前正在显示示例；点顶部横幅「开始使用（清除示例）」即可清除。')
                    : (p.demo && !p.demo.empty ? h('div', { className: 'fde-hint' }, t('demoRestoreBlocked')) : null)),
                h('div', { className: 'fde-set-ctl' },
                  h(Btn, {
                    small: true,
                    kind: 'primary',
                    busy: p.demoBusy === 'restore',
                    disabled: !!(p.demo && p.demo.active),
                    onClick: p.onDemoRestore,
                  }, p.demoBusy === 'restore' ? t('demoRestoring') : t('demoRestore')))),
            ],
          })),
        h('div', { className: 'fde-card' },
          Section({
            title: t('settingsHealth'),
            actions: h(Btn, { small: true, onClick: runHealth, busy: healthLoading }, healthLoading ? t('settingsHealthRunning') : t('settingsHealthRun')),
            children: [
              healthErr ? h(ErrorLine, { title: t('loadFail'), text: healthErr, onRetry: runHealth }) : null,
              !health && !healthErr
                ? h('div', { className: 'fde-hint' }, t('settingsHealthEmpty'))
                : (health
                  ? h('div', null,
                    h('div', { className: 'fde-row', style: { marginBottom: 8 } },
                      (function () {
                        const hasFail = health.some((c) => str(c && c.status).toLowerCase() === 'fail');
                        return Chip({ tone: hasFail ? 'danger' : 'ok', children: hasFail ? t('settingsHealthFail') : t('settingsHealthOk') });
                      })()),
                    h('div', { className: 'fde-health' }, health.map((c, i) => h('div', { key: 'hc-' + i, className: 'fde-health-item' },
                      h('span', { className: 'fde-health-name' }, str(c && c.name)),
                      healthBadge(c && c.status),
                      h('span', { className: 'fde-health-detail' }, str(c && c.detail))))))
                  : null),
            ],
          })),
        h('div', { className: 'fde-card' },
          Section({
            title: t('settingsRules'),
            children: asList(meta && meta.rules).length
              ? h('div', { className: 'fde-row' }, asList(meta.rules).map((r) => h('span', {
                key: r.key, className: 'fde-chip muted', title: r.desc || '',
              }, r.label || r.key)))
              : h('div', { className: 'fde-hint' }, '宿主未返回规则清单。'),
          })),
        h('div', { className: 'fde-card' },
          Section({
            title: t('settingsRestart'),
            children: [
              h('div', { className: 'fde-note' }, t('settingsRestartBody')),
              h('div', { className: 'fde-tip', style: { marginTop: 8 } },
                '重启方式：退出并重新打开 DSH（宿主半路由与技能注册在启动时加载），随后刷新此页面。'),
              h('div', { className: 'fde-row', style: { marginTop: 10 } },
                p.onReprobe ? h(Btn, { small: true, onClick: p.onReprobe }, '重新探测 FDE 路由') : null),
            ],
          })));
    }

    /* ============================================================
     * 十三、抽屉（客户 / 任务）
     * 客户抽屉：阶段步进（受门禁）、门禁清单（自动项 + 人工勾选 + 证据）、
     *           下一步编辑、干系人、工件、时间线、启动会话/暂停/归档。
     * 任务抽屉：编辑字段、回报历史、关联会话、启动会话/删除。
     * 破坏性操作由根组件弹二次确认；此处只发请求意图。
     * ============================================================ */

    function DrawerShell(props) {
      const p = props || {};
      return h('div', {
        className: 'fde-mask',
        role: 'presentation',
        onMouseDown: (e) => { if (e && e.target === e.currentTarget && p.onClose) p.onClose(); },
      },
        h('div', {
          className: 'fde-drawer',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': p.titleText || t('drawerEngagement'),
          onKeyDown: (e) => { if (e && e.key === 'Escape' && p.onClose) p.onClose(); },
        },
          h('div', { className: 'fde-drawer-head' },
            h('div', { className: 'fde-drawer-head-main' },
              h('div', { className: 'fde-drawer-title' }, p.title),
              p.subtitle ? h('div', { className: 'fde-drawer-sub' }, p.subtitle) : null),
            h('button', {
              type: 'button', className: 'fde-drawer-close', 'aria-label': t('drawerClose'),
              autoFocus: true, onClick: p.onClose,
            }, '×')),
          h('div', { className: 'fde-drawer-body' }, p.children),
          p.footer ? h('div', { className: 'fde-drawer-foot' }, p.footer) : null));
    }

    function EngagementDrawer(props) {
      const p = props || {};
      const meta = p.meta;
      const board = p.board || {};
      const eng = p.engagement;
      const [targetStage, setTargetStage] = useState('');
      const [gateChecks, setGateChecks] = useState({});
      const [dirty, setDirty] = useState(false);
      const [nextText, setNextText] = useState(str((eng.nextAction || {}).text));
      const [nextDue, setNextDue] = useState(normDay((eng.nextAction || {}).due));
      const [nextOwner, setNextOwner] = useState(str((eng.nextAction || {}).owner));
      const [stakeholders, setStakeholders] = useState(asList(eng.stakeholders).map((s) => Object.assign({}, s)));
      const [stakeMsg, setStakeMsg] = useState('');
      const stages = asList(meta && meta.stages);
      const stageIdx = stageIndex(meta, eng.stage);
      const nextStage = stages[stageIdx + 1] || null;
      const chosenStage = targetStage || (nextStage ? nextStage.key : eng.stage);
      const chosenDef = stageOf(meta, chosenStage);
      const gateDef = gateOfStage(meta, chosenStage);
      const gateInfo = p.gateInfo && p.gateInfo.stage === chosenStage ? p.gateInfo : null;
      const gateStatus = str(pick(gateInfo && gateInfo.gate && gateInfo.gate.status, ''));
      const gateMissing = asList(gateInfo && gateInfo.missing);
      const timeline = asList(eng.timeline).slice(-30).reverse();
      const engagementItems = asList(board.items).filter((it) => it && it.engagementId === eng.id);
      const artGroups = groupFiles(p.files);

      useEffect(() => { if (p.onGateEvaluate) p.onGateEvaluate(chosenStage); }, [chosenStage, eng.id]);

      useEffect(() => {
        setDirty(false);
        const serverChecks = manualChecksOf(eng, chosenStage);
        const next = {};
        asList(gateDef.manual).forEach((c) => {
          const sv = serverChecks[c.key];
          const ok = sv && (sv.status === 'pass' || sv === true);
          next[c.key] = { pass: !!ok, evidence: str(sv && sv.evidence) };
        });
        setGateChecks(next);
      }, [chosenStage, eng.id, eng.updatedAt]);

      useEffect(() => {
        if (!gateInfo || dirty) return;
        const manual = asList(gateInfo.gate && gateInfo.gate.manual);
        if (!manual.length) return;
        setGateChecks((cur) => {
          const next = Object.assign({}, cur);
          manual.forEach((m) => {
            const ok = m.status === 'pass' || m.ok === true;
            next[m.key] = { pass: !!ok, evidence: str(pick(m.evidence, (cur[m.key] || {}).evidence)) };
          });
          return next;
        });
      }, [gateInfo && gateInfo.at, eng.id, chosenStage]);

      const toggleCheck = (key, pass) => {
        setDirty(true);
        setGateChecks((cur) => Object.assign({}, cur, { [key]: Object.assign({}, cur[key] || {}, { pass }) }));
      };
      const setEvidence = (key, evidence) => {
        setDirty(true);
        setGateChecks((cur) => Object.assign({}, cur, { [key]: Object.assign({}, cur[key] || {}, { evidence }) }));
      };
      const checksPayload = () => {
        const out = {};
        Object.keys(gateChecks).forEach((k) => {
          out[k] = { status: gateChecks[k].pass ? 'pass' : 'pending', evidence: str(gateChecks[k].evidence) };
        });
        return out;
      };
      const manualDefs = asList(gateDef.manual);
      const manualPass = manualDefs.filter((c) => gateChecks[c.key] && gateChecks[c.key].pass).length;
      const autoDefs = asList(gateDef.auto);
      const gateAuto = asList(gateInfo && gateInfo.gate && gateInfo.gate.auto).length
        ? asList(gateInfo.gate.auto)
        : autoDefs.map((c) => ({ key: c.key, label: c.label, ok: null, evidence: '' }));

      const setStake = (idx, key, val) => {
        setStakeholders((cur) => cur.map((s, i) => (i === idx ? Object.assign({}, s, { [key]: val }) : s)));
        setStakeMsg('');
      };
      const addStake = () => setStakeholders((cur) => cur.concat([{ name: '', role: '', level: 'unknown', stance: '', verified: false }]));
      const removeStake = (idx) => setStakeholders((cur) => cur.filter((s, i) => i !== idx));

      /* ---------- 区块 ---------- */
      const stageBlock = h('div', { key: 'stage', className: 'fde-block' },
        h('div', { className: 'fde-block-head' },
          h('span', { className: 'fde-block-title' }, t('drawerStage')),
          stageIdx >= 0 ? h('span', { className: 'fde-hint' }, '当前第 ' + (stageIdx + 1) + ' / ' + stages.length + ' 阶段') : null),
        h('div', { className: 'fde-stepper', role: 'group', 'aria-label': t('drawerStage') },
          stages.map((s, i) => h('button', {
            key: s.key,
            type: 'button',
            className: 'fde-step' + (s.key === eng.stage ? ' on' : '') + (i < stageIdx ? ' done' : '') + (eng.paused ? ' paused' : ''),
            title: s.definition || s.label,
            'aria-label': '阶段 ' + s.label + (i < stageIdx ? '（已完成）' : ''),
            onClick: () => {
              if (s.key === eng.stage) return;
              if (i < stageIdx && p.onMoveBack) p.onMoveBack(s.key);
              else if (p.onMoveStage) p.onMoveStage(s.key);
            },
          },
            h('span', { className: 'fde-step-num' }, String(i + 1)),
            h('span', null, s.label)))),
        nextStage
          ? h('div', { className: 'fde-row', style: { marginTop: 6 } },
            h('span', { className: 'fde-hint' }, '推进到「' + nextStage.label + '」需要通过门禁：' + (gateOfStage(meta, nextStage.key).label || nextStage.key)),
            h(Btn, { small: true, kind: 'primary', onClick: () => p.onMoveStage && p.onMoveStage(nextStage.key) }, '推进到' + nextStage.label))
          : h('div', { className: 'fde-hint' }, '已是最后一个阶段'));

      const gateAutoRow = (c) => {
        const okDesc = c.ok === true ? '通过' : (c.ok === false ? '未通过' : '未评估');
        return h('div', {
          key: 'auto-' + c.key,
          className: 'fde-gate-item' + (c.ok === true ? ' pass' : (c.ok === false ? ' missing' : '')),
        },
          h('div', { className: 'fde-gate-line' },
            Dot({ tone: c.ok === true ? 'ok' : (c.ok === false ? 'alert' : 'warn') }),
            h('span', null, c.label || c.key),
            h('span', { className: 'fde-gate-key' }, c.key),
            h('span', { className: 'fde-spacer', style: { flex: '1 1 auto' } }),
            h('span', { className: 'fde-hint' }, okDesc)),
          c.evidence ? h('div', { className: 'fde-hint' }, '证据：' + c.evidence) : null);
      };
      const gateManualRow = (c) => h('div', {
        key: 'man-' + c.key,
        className: 'fde-gate-item' + (gateChecks[c.key] && gateChecks[c.key].pass ? ' pass' : ''),
      },
        h('label', { className: 'fde-check' },
          h('input', {
            type: 'checkbox',
            checked: !!(gateChecks[c.key] && gateChecks[c.key].pass),
            'aria-label': c.label,
            onChange: (e) => toggleCheck(c.key, !!(e && e.target && e.target.checked)),
          }),
          h('span', null, c.label || c.key),
          h('span', { className: 'fde-gate-key' }, c.key)),
        h('input', {
          className: 'fde-input fde-gate-evidence',
          type: 'text',
          value: str((gateChecks[c.key] || {}).evidence),
          placeholder: t('drawerGateEvidencePh'),
          'aria-label': (c.label || c.key) + ' 证据',
          onChange: (e) => setEvidence(c.key, e && e.target ? e.target.value : ''),
        }));

      const gateBlock = h('div', { key: 'gate', className: 'fde-block' },
        h('div', { className: 'fde-block-head' },
          h('span', { className: 'fde-block-title' }, t('drawerGate') + ' · ' + (chosenDef ? chosenDef.label : chosenStage)),
          h('span', { className: 'fde-hint' }, t('drawerGateFor') + '「' + (chosenDef ? chosenDef.label : chosenStage) + '」'),
          h(Btn, { small: true, onClick: () => p.onGateEvaluate && p.onGateEvaluate(chosenStage), busy: !!p.gateLoading }, t('drawerGateEvaluate'))),
        gateStatus
          ? Chip({ tone: gateStatus === 'pass' || gateStatus === 'forced' ? 'ok' : 'warn', children: gateStatus === 'pass' ? t('drawerGatePassed') : (gateStatus === 'forced' ? '已强制通过' : t('drawerGatePending')) })
          : null,
        p.gateError ? h(MsgLine, { kind: 'err', text: p.gateError }) : null,
        autoDefs.length
          ? h('div', { className: 'fde-gate-list' },
            h('div', { className: 'fde-hint' }, t('drawerGateAuto') + '（宿主计算，只读）'),
            gateAuto.map(gateAutoRow))
          : h('div', { className: 'fde-hint' }, '该阶段没有自动检查项。'),
        manualDefs.length
          ? h('div', null,
            h('div', { className: 'fde-hint', style: { margin: '10px 0 4px' } },
              t('drawerGateManual') + '（' + manualPass + '/' + manualDefs.length + ' 已确认，需人工勾选并留证据）'),
            h('div', { className: 'fde-gate-list' }, manualDefs.map(gateManualRow)),
            h('div', { className: 'fde-row', style: { marginTop: 8 } },
              h(Btn, { small: true, kind: 'primary', onClick: () => p.onGateSave && p.onGateSave(chosenStage, checksPayload()) }, t('drawerGateSave')),
              h('span', { className: 'fde-hint' }, '保存只记录人工确认，不会自动推进阶段。')))
          : h('div', { className: 'fde-hint' }, '该阶段没有人工确认项。'),
        gateMissing.length
          ? h('div', { style: { marginTop: 8 } },
            h('div', { className: 'fde-hint', style: { color: 'var(--fde-danger)' } }, t('drawerGateMissing') + '：'),
            h(MissingList, { items: gateMissing }))
          : null,
        h('div', { className: 'fde-row', style: { marginTop: 8 } },
          h(Btn, { small: true, kind: 'warn', onClick: () => p.onForceGate && p.onForceGate(chosenStage, gateMissing) }, t('drawerGateForce')),
          h('span', { className: 'fde-hint' }, '强制会记录理由与人工覆盖，需二次确认。')));

      const nextBlock = h('div', { key: 'next', className: 'fde-block' },
        h('div', { className: 'fde-block-head' }, h('span', { className: 'fde-block-title' }, t('drawerNext'))),
        h('div', { className: 'fde-form-grid' },
          h(Field, { label: t('drawerNextText'), full: true },
            h(TextInput, { value: nextText, placeholder: '如：补 KPI 假设第三段', onChange: (e) => setNextText(e.target.value) })),
          h(Field, { label: t('drawerNextDue') },
            h(TextInput, { type: 'date', value: nextDue, onChange: (e) => setNextDue(e.target.value) })),
          h(Field, { label: t('drawerNextOwner') },
            h(TextInput, { value: nextOwner, placeholder: 'Neo', onChange: (e) => setNextOwner(e.target.value) }))),
        h('div', { className: 'fde-row', style: { marginTop: 8 } },
          h(Btn, { small: true, kind: 'primary', onClick: () => p.onSaveNext && p.onSaveNext({ text: nextText, due: nextDue, owner: nextOwner }) }, t('drawerSaveNext')),
          h('span', { className: 'fde-hint' }, '下一步写入 board，用于今日/看板提醒。')));

      const stakeRow = (s, i) => h('div', { key: 'st-' + i, className: 'fde-row', style: { alignItems: 'flex-end' } },
        h(Field, { label: t('drawerName') },
          h(TextInput, { value: str(s.name), style: { width: 110 }, onChange: (e) => setStake(i, 'name', e.target.value) })),
        h(Field, { label: t('drawerRole') },
          h(TextInput, { value: str(s.role), style: { width: 110 }, onChange: (e) => setStake(i, 'role', e.target.value) })),
        h(Field, { label: t('drawerLevel') },
          h(Select, {
            value: str(s.level || 'unknown'),
            options: Object.keys(LEVEL_FALLBACK).map((k) => ({ value: k, label: LEVEL_FALLBACK[k] })),
            onChange: (e) => setStake(i, 'level', e.target.value),
          })),
        Checkbox({ checked: !!s.verified, label: t('drawerVerified'), onChange: (v) => setStake(i, 'verified', v) }),
        h(Btn, { small: true, kind: 'danger', onClick: () => removeStake(i), ariaLabel: '删除干系人 ' + (s.name || i) }, '删除'));

      const stakeBlock = h('div', { key: 'stake', className: 'fde-block' },
        h('div', { className: 'fde-block-head' },
          h('span', { className: 'fde-block-title' }, t('drawerStakeholders') + (stakeholders.length ? '（' + stakeholders.length + '）' : '')),
          h('div', { className: 'fde-spacer' }),
          h(Btn, { small: true, onClick: addStake }, t('drawerAddStakeholder'))),
        stakeholders.length === 0
          ? h('div', { className: 'fde-hint' }, t('drawerNoStakeholders'))
          : h('div', { className: 'fde-stack' }, stakeholders.map(stakeRow)),
        stakeMsg ? h(MsgLine, { kind: 'ok', text: stakeMsg }) : null,
        h('div', { className: 'fde-row', style: { marginTop: 8 } },
          h(Btn, {
            small: true, kind: 'primary',
            onClick: async () => {
              if (!p.onSaveStakeholders) return;
              const r = await p.onSaveStakeholders(stakeholders.filter((s) => str(s.name).trim()));
              if (r && r.ok) setStakeMsg('干系人已保存');
            },
          }, '保存干系人')));

      const artFileRow = (f) => h('div', { key: f.rel, className: 'fde-file' },
        h('span', { className: 'fde-file-rel' }, f.rel),
        f.exported ? Chip({ tone: 'ok', children: t('artifactsExported') }) : null,
        p.onOpenPath
          ? h(Btn, {
            small: true,
            onClick: () => p.onOpenPath(p.filesBase ? String(p.filesBase).replace(/\/+$/, '') + '/' + f.rel : '', 'reveal', f.rel, 'file'),
          }, t('reveal'))
          : null);

      const artBlock = h('div', { key: 'art', className: 'fde-block' },
        h('div', { className: 'fde-block-head' },
          h('span', { className: 'fde-block-title' }, t('drawerArtifacts')),
          h('div', { className: 'fde-spacer' }),
          h(Btn, { small: true, onClick: p.onLoadFiles, busy: !!p.filesLoading }, '读取工件')),
        p.files === null
          ? h('div', { className: 'fde-hint' }, t('drawerNoArtifacts'))
          : (artGroups.length === 0
            ? h('div', { className: 'fde-hint' }, t('drawerNoArtifacts'))
            : h('div', null, artGroups.map((g) => h('div', { key: g.key, className: 'fde-group' },
              h('div', { className: 'fde-group-title' }, g.key, h('span', { className: 'fde-hint' }, '（' + g.files.length + '）')),
              h('div', { className: 'fde-files' }, g.files.slice(0, 16).map(artFileRow)))))));

      const tlRow = (e, i) => h('div', { key: 'tl-' + i, className: 'fde-tl-item' },
        h('div', { className: 'fde-tl-rail' }, h('span', { className: 'fde-tl-dot ' + str(pick(e.by, e.kind)) })),
        h('div', { className: 'fde-tl-main' },
          h('div', { className: 'fde-tl-text' }, e.text),
          h('div', { className: 'fde-tl-time' }, fmtDateTime(e.at) + (e.kind ? ' · ' + e.kind : '') + (e.by ? ' · ' + e.by : ''))));

      const timelineBlock = h('div', { key: 'tl', className: 'fde-block' },
        h('div', { className: 'fde-block-head' }, h('span', { className: 'fde-block-title' }, t('drawerTimeline'))),
        timeline.length === 0
          ? h('div', { className: 'fde-hint' }, t('drawerNoTimeline'))
          : h('div', { className: 'fde-timeline' }, timeline.map(tlRow)));

      const relatedItemRow = (it) => h('button', {
        key: it.id, type: 'button', className: 'fde-li',
        style: { background: 'transparent', border: 0, width: '100%', textAlign: 'left', font: 'inherit', color: 'inherit', cursor: 'pointer' },
        onClick: () => p.onOpenItem && p.onOpenItem(it.id),
      },
        h('div', { className: 'fde-li-main' },
          h('div', { className: 'fde-li-title' }, it.title),
          h('div', { className: 'fde-li-meta' },
            Chip({ tone: 'muted', children: laneLabel(meta, it.stage) }),
            Chip({ tone: 'muted', children: typeLabel(meta, it.type) }),
            it.due ? h('span', null, fmtDay(it.due)) : null)));

      const itemsBlock = engagementItems.length
        ? h('div', { key: 'items', className: 'fde-block' },
          h('div', { className: 'fde-block-head' },
            h('span', { className: 'fde-block-title' }, '该客户的任务（' + engagementItems.length + '）')),
          h('div', { className: 'fde-list' }, engagementItems.slice(0, 12).map(relatedItemRow)))
        : null;


      /* ---------- 招采雷达（v1.1）：统计 / 匹配 Top5 / 已关联 / 开关 ---------- */
      const bidsData = p.bids || null;
      const bidsLoading = !!p.bidsLoading;
      const bidsError = str(p.bidsError || '');
      const bidWatchOn = !(eng.bidWatch && eng.bidWatch.enabled === false);
      const linkedMap = bidLinkedIdSet(bidsData || {});
      const drawerBidBusy = str(p.bidBusy || '');
      const bidMatchRow = (item) => {
        const linked = !!linkedMap[item.id];
        const rel = bidRelationMeta(item.relation || bidRelationDerived(item));
        return h('div', { key: item.id || item.key, className: 'fde-bid-row' },
          h('div', { className: 'fde-bid-main' },
            h('div', { className: 'fde-bid-title' },
              h('span', { className: 'fde-bid-rel fde-bid-rel-' + rel.key }, rel.label),
              h('span', { className: 'fde-bid-title-text' }, item.title)),
            h('div', { className: 'fde-bid-meta' },
              item.date ? h('span', { className: 'fde-num' }, fmtDay(item.date)) : null,
              item.buyer ? h('span', { className: 'fde-bid-kv', title: t('bidBuyer') }, t('bidBuyer') + '：' + item.buyer) : null,
              item.winner ? h('span', { className: 'fde-bid-kv', title: t('bidWinner') }, t('bidWinner') + '：' + item.winner) : null,
              item.amountText ? h('span', { className: 'fde-bid-kv', title: t('bidAmountTip') }, t('bidAmount') + '：' + item.amountText) : null)),
          h('div', { className: 'fde-bid-actions' },
            h(Btn, {
              small: true, kind: 'primary',
              disabled: drawerBidBusy === 'bid-promote:' + item.id,
              onClick: () => p.onBidPromote && p.onBidPromote(item),
            }, t('bidAddFollowup')),
            linked
              ? Chip({ tone: 'ok', children: t('bidLinked') })
              : h(Btn, {
                small: true,
                disabled: drawerBidBusy === 'bid-link:' + item.id,
                onClick: () => p.onBidLink && p.onBidLink(item),
              }, t('bidLink')),
            item.url
              ? h('a', { className: 'fde-link fde-link-btn', href: item.url, target: '_blank', rel: 'noreferrer noopener' }, t('bidOpenSource'))
              : null));
      };
      const bidLinkedRow = (link) => {
        const rel = bidRelationMeta(link.relation || 'mention');
        return h('div', { key: 'lnk-' + link.bidId, className: 'fde-bid-row' },
          h('div', { className: 'fde-bid-main' },
            h('div', { className: 'fde-bid-title' },
              h('span', { className: 'fde-bid-rel fde-bid-rel-' + rel.key }, rel.label),
              h('span', { className: 'fde-bid-title-text' }, link.title)),
            h('div', { className: 'fde-bid-meta' },
              link.date ? h('span', { className: 'fde-num' }, fmtDay(link.date)) : null,
              link.note ? h('span', { className: 'fde-bid-kv' }, t('bidNote') + '：' + link.note) : null,
              link.linkedAt ? h('span', { className: 'fde-dim' }, relTime(link.linkedAt)) : null,
              link.by ? h('span', { className: 'fde-dim' }, link.by === 'agent' ? 'agent 关联' : '人工关联') : null)),
          h('div', { className: 'fde-bid-actions' },
            link.url
              ? h('a', { className: 'fde-link fde-link-btn', href: link.url, target: '_blank', rel: 'noreferrer noopener' }, t('bidOpenSource'))
              : null,
            h(Btn, {
              small: true, kind: 'danger',
              disabled: drawerBidBusy === 'bid-unlink:' + link.bidId,
              onClick: () => p.onBidUnlink && p.onBidUnlink(link),
            }, t('bidUnlink'))));
      };
      const bidsBlock = h('div', { key: 'bids', className: 'fde-block' },
        h('div', { className: 'fde-block-head' },
          h('span', { className: 'fde-block-title' }, t('bidTitle')),
          bidsData && bidsData.available ? h('span', { className: 'fde-hint' },
            (bidsData.stats ? '相关 ' + bidsData.stats.total + ' 条' : '')) : null,
          h('div', { className: 'fde-spacer' }),
          h(Btn, {
            small: true,
            busy: drawerBidBusy === 'bid-refresh',
            onClick: () => p.onBidsRefresh && p.onBidsRefresh(),
          }, t('bidRefresh'))),
        bidsLoading && !bidsData
          ? h(Loading, { key: 'l', text: '正在匹配招采记录…' })
          : (bidsError
            ? h(ErrorLine, { key: 'e', title: t('loadFail'), text: bidsError, onRetry: () => p.onBidsRefresh && p.onBidsRefresh() })
            : (bidsData && bidsData.available === false
              ? h(BidUnavailable, { key: 'u', reason: bidsData.reason, onRetry: () => p.onBidsRefresh && p.onBidsRefresh() })
              : (bidsData
                ? h('div', { key: 'ok' },
                  h('div', { className: 'fde-row', style: { rowGap: 6 } },
                    bidStatBadges(bidsData),
                    h('div', { className: 'fde-spacer' }),
                    Checkbox({
                      checked: bidWatchOn,
                      label: t('bidWatchLabel'),
                      title: t('bidWatchHint'),
                      onChange: (v) => p.onToggleBidWatch && p.onToggleBidWatch(v),
                    })),
                  asList(bidsData.queries).length
                    ? h('div', { className: 'fde-hint', style: { marginTop: 4 } }, t('bidQueries') + '：' + asList(bidsData.queries).join('、'))
                    : null,
                  h('div', { className: 'fde-bid-subtitle' }, t('bidMatchTop')),
                  asList(bidsData.items).length
                    ? h('div', { className: 'fde-bid-list' }, asList(bidsData.items).slice(0, 5).map(bidMatchRow))
                    : h('div', { className: 'fde-hint' }, t('bidNoMatch')),
                  h('div', { className: 'fde-bid-subtitle' }, t('bidLinksTitle') + (asList(bidsData.linked).length ? '（' + asList(bidsData.linked).length + '）' : '')),
                  asList(bidsData.linked).length
                    ? h('div', { className: 'fde-bid-list' }, asList(bidsData.linked).map(bidLinkedRow))
                    : h('div', { className: 'fde-hint' }, t('bidNoLinked')),
                  h('div', { className: 'fde-hint', style: { marginTop: 6 } }, t('bidPageHint')))
                : h('div', { key: 'idle', className: 'fde-hint' }, t('bidIdle'))))));

      const footer = [
        h(Btn, { key: 'handoff', kind: 'primary', onClick: p.onHandoff }, t('drawerStartSession')),
        h(Btn, { key: 'pause', onClick: () => p.onPause && p.onPause(!eng.paused) }, eng.paused ? t('drawerResume') : t('drawerPause')),
        h('div', { key: 'sp', className: 'fde-spacer' }),
        h(Btn, { key: 'archive', kind: 'danger', onClick: p.onArchive }, t('drawerArchive')),
      ];

      const titleNode = [
        h('span', { key: 'n' }, eng.name || eng.company || eng.dir || '—'),
        h('span', { key: 's', className: 'fde-chip on' }, stageLabel(meta, eng.stage)),
        eng.paused ? h('span', { key: 'p', className: 'fde-chip warn' }, t('drawerPaused')) : null,
      ];
      const subtitle = [
        eng.company && eng.company !== eng.name ? h('span', { key: 'c' }, eng.company) : null,
        eng.dir ? h('span', { key: 'd', className: 'fde-code' }, eng.dir) : null,
        h('span', { key: 'id', className: 'fde-dim' }, eng.id),
      ];

      return h(DrawerShell, {
        titleText: '客户：' + (eng.name || eng.company || eng.dir || ''),
        title: titleNode,
        subtitle,
        onClose: p.onClose,
        children: [stageBlock, gateBlock, nextBlock, stakeBlock, artBlock, bidsBlock, timelineBlock, itemsBlock],
        footer,
      });
    }

    function ItemDrawer(props) {
      const p = props || {};
      const meta = p.meta;
      const board = p.board || {};
      const it = p.item;
      const eng = it.engagementId ? findEngagement(board, it.engagementId) : null;
      const [title, setTitle] = useState(str(it.title));
      const [type, setType] = useState(str(it.type));
      const [lane, setLane] = useState(str(it.stage));
      const [priority, setPriority] = useState(str(it.priority || 'normal'));
      const [due, setDue] = useState(normDay(it.due));
      const [owner, setOwner] = useState(str(it.owner || 'human'));
      const [engagementId, setEngagementId] = useState(str(it.engagementId));
      const [reportKind, setReportKind] = useState('progress');
      const [reportText, setReportText] = useState('');
      const [reportErr, setReportErr] = useState('');
      const [savedMsg, setSavedMsg] = useState(null);
      const [answer, setAnswer] = useState('');
      const alive = useRef(true);
      useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

      const save = async () => {
        if (!p.onSave) return;
        /* 宿主契约：改泳道必须用 action=move（update 会拒绝 stage）。 */
        const r = await p.onSave({
          patch: {
            title, type, priority, due: due || '', owner,
            engagementId: engagementId || '',
          },
          lane,
        });
        if (r && r.ok) setSavedMsg({ kind: 'ok', text: '任务已保存' });
        else setSavedMsg({ kind: 'err', text: (r && r.reason) || t('actionFail') });
      };
      const submitReport = () => {
        if (!str(reportText).trim()) { setReportErr(t('drawerReportRequired')); return; }
        setReportErr('');
        if (p.onReport) p.onReport(reportKind, reportText);
        setReportText('');
      };
      const reports = asList(it.reports).slice().reverse();
      const itemTypes = asList(meta && meta.itemTypes);
      const lanes = asList(meta && meta.lanes);
      const priorities = asList(meta && meta.priorities);
      const ownerOptions = [
        { value: 'human', label: t('drawerItemOwnerHuman') },
        { value: 'agent', label: t('drawerItemOwnerAgent') },
        { value: 'both', label: t('drawerItemOwnerBoth') },
      ];
      const attention = it.attention && typeof it.attention === 'object' ? it.attention : null;

      const fields = h('div', { key: 'fields', className: 'fde-block' },
        h('div', { className: 'fde-form-grid' },
          h(Field, { label: t('drawerItemTitle'), full: true }, h(TextInput, { value: title, onChange: (e) => setTitle(e.target.value) })),
          h(Field, { label: t('drawerItemType') }, h(Select, {
            value: type, options: itemTypes.map((x) => ({ value: x.key, label: x.label })),
            onChange: (e) => setType(e.target.value),
          })),
          h(Field, { label: t('drawerItemLane') }, h(Select, {
            value: lane, options: lanes.map((x) => ({ value: x.key, label: x.label })),
            onChange: (e) => setLane(e.target.value),
          })),
          h(Field, { label: t('drawerItemPriority') }, h(Select, {
            value: priority, options: priorities.map((x) => ({ value: x.key, label: x.label })),
            onChange: (e) => setPriority(e.target.value),
          })),
          h(Field, { label: t('drawerItemDue') }, h(TextInput, { type: 'date', value: due, onChange: (e) => setDue(e.target.value) })),
          h(Field, { label: t('drawerItemOwner') }, h(Select, {
            value: owner, options: ownerOptions, onChange: (e) => setOwner(e.target.value),
          })),
          h(Field, { label: t('drawerItemEngagement') }, h(Select, {
            value: engagementId,
            options: [{ value: '', label: t('drawerItemIndependent') }].concat(
              asList(board.engagements).map((e) => ({ value: e.id, label: e.shortName || e.name || e.dir }))
            ),
            onChange: (e) => setEngagementId(e.target.value),
          }))),
        h('div', { className: 'fde-row', style: { marginTop: 8 } },
          h(Btn, { small: true, kind: 'primary', onClick: save }, t('drawerSaveItem')),
          h('span', { className: 'fde-hint' }, '修改泳道等同移动卡片；进入 done 仍需要证据。')));

      const attentionBlock = attention
        ? h('div', { key: 'attn', className: 'fde-block' },
          h('div', { className: 'fde-block-head' }, h('span', { className: 'fde-block-title' }, t('drawerAttention'))),
          h('div', { className: 'fde-gate-item' },
            h('div', { className: 'fde-gate-line' },
              Chip({ tone: 'warn', children: attentionMeta(meta, attention.kind || 'decision').label }),
              h('span', null, str(pick(attention.question, attention.text, '—')))),
            h('div', { className: 'fde-row' },
              h(TextInput, { value: answer, placeholder: t('drawerAnswerPh'), ariaLabel: t('drawerAnswerPh'), onChange: (e) => setAnswer(e.target.value) }),
              h(Btn, { small: true, kind: 'primary', onClick: () => p.onResolveAttention && p.onResolveAttention('item', it.id, answer) }, t('drawerResolve')))))
        : null;

      const reportRow = (r, i) => h('div', { key: 'rp-' + i, className: 'fde-report' },
        h('div', { className: 'fde-report-head' },
          Chip({ tone: r.kind === 'ready' ? 'ok' : (r.kind === 'blocked' || r.kind === 'failed' ? 'danger' : 'muted'), children: str(r.kind) }),
          h('span', { className: 'fde-dim' }, fmtDateTime(r.at))),
        h('div', { className: 'fde-report-text' }, str(r.text)),
        asList(r.artifacts).length ? h('div', { className: 'fde-hint' }, '产物：' + asList(r.artifacts).join('、')) : null);

      const reportsBlock = h('div', { key: 'reports', className: 'fde-block' },
        h('div', { className: 'fde-block-head' },
          h('span', { className: 'fde-block-title' }, t('drawerReports') + (reports.length ? '（' + reports.length + '）' : '')),
          h('div', { className: 'fde-spacer' }),
          h('span', { className: 'fde-hint' }, 'agent 通过 fde_item report 回报')),
        reports.length === 0
          ? h('div', { className: 'fde-hint' }, t('drawerNoReports'))
          : h('div', { className: 'fde-stack' }, reports.slice(0, 20).map(reportRow)));

      const reportNowBlock = h('div', { key: 'reportNow', className: 'fde-block' },
        h('div', { className: 'fde-block-head' }, h('span', { className: 'fde-block-title' }, t('drawerReportNow'))),
        h(Select, {
          value: reportKind, ariaLabel: t('drawerReportKind'),
          options: [
            { value: 'progress', label: '进度' }, { value: 'ready', label: '完成待审' },
            { value: 'blocked', label: '受阻' }, { value: 'failed', label: '失败' },
            { value: 'dropped', label: '放弃' },
          ],
          onChange: (e) => setReportKind(e.target.value),
        }),
        h(TextArea, {
          value: reportText, placeholder: t('drawerReportText'), ariaLabel: t('drawerReportText'),
          onChange: (e) => { setReportText(e.target.value); setReportErr(''); },
        }),
        reportErr ? h('div', { className: 'fde-msg err', role: 'alert' }, reportErr) : null,
        h('div', { className: 'fde-row', style: { marginTop: 6 } },
          h(Btn, { small: true, kind: 'primary', onClick: submitReport }, t('drawerReportSubmit')),
          h('span', { className: 'fde-hint' }, 'ready 会自动移到「待我审」；blocked 移到「等外部」并生成注意力。')));

      const sessionBlock = h('div', { key: 'session', className: 'fde-block' },
        h('div', { className: 'fde-block-head' }, h('span', { className: 'fde-block-title' }, t('drawerSession'))),
        it.sessionId
          ? h('div', { className: 'fde-row' },
            h('span', { className: 'fde-code' }, it.sessionId),
            h(Btn, { small: true, onClick: () => p.onOpenSession && p.onOpenSession(it.sessionId) }, t('open')))
          : h('div', { className: 'fde-hint' }, '还没有关联会话；点「启动会话」按阶段模板派发。'));

      const titleNode = [
        h('span', { key: 't' }, it.title || t('drawerItem')),
        h('span', { key: 'l', className: 'fde-chip on' }, laneLabel(meta, it.stage)),
      ];
      const subtitle = [
        eng ? h('span', { key: 'e' }, eng.shortName || eng.name) : h('span', { key: 'e' }, t('drawerItemIndependent')),
        h('span', { key: 'id', className: 'fde-dim' }, it.id),
      ];
      const footer = [
        h(Btn, { key: 'handoff', kind: 'primary', onClick: p.onHandoff }, t('drawerStartSession')),
        h('div', { key: 'sp', className: 'fde-spacer' }),
        h(Btn, { key: 'del', kind: 'danger', onClick: p.onDelete }, t('drawerDelete')),
      ];

      return h(DrawerShell, {
        titleText: '任务：' + it.title,
        title: titleNode,
        subtitle,
        onClose: p.onClose,
        children: [
          savedMsg ? h(MsgLine, { key: 'm', kind: savedMsg.kind, text: savedMsg.text, onClose: () => setSavedMsg(null) }) : null,
          fields, attentionBlock, reportsBlock, reportNowBlock, sessionBlock,
        ],
        footer,
      });
    }

    /* ============================================================
     * 十三之二、Phase 2 页型壳（layout.md §7）
     * 5 页签只组合既有视图；页内视图切换（客户 3 态 / 资料 2 态 / 流程 3 态）
     * 与页头设置入口在这里承载，各视图组件保持原有数据与行为。
     * ============================================================ */
    function PageTabs(props) {
      const p = props || {};
      return h('div', { className: 'fde-pagebar' },
        h('div', { className: 'fde-seg', role: 'tablist', 'aria-label': p.ariaLabel || '' },
          asList(p.items).map((it) => h('button', {
            key: it.key,
            type: 'button',
            role: 'tab',
            'aria-selected': p.value === it.key ? 'true' : 'false',
            className: p.value === it.key ? 'on' : '',
            onClick: () => { if (p.onChange) p.onChange(it.key); },
          }, it.label))),
        p.extra || null);
    }

    function CustomersPage(props) {
      const p = props || {};
      const tab = p.tab === 'board-item' ? 'board-item' : (p.tab === 'list' ? 'list' : 'board-customer');
      return h('div', { className: 'fde-view fde-view-fill' },
        PageTabs({
          ariaLabel: t('customersViews'),
          value: tab,
          items: [
            { key: 'board-customer', label: t('customersViewBoardCustomer') },
            { key: 'board-item', label: t('customersViewBoardTask') },
            { key: 'list', label: t('customersViewList') },
          ],
          onChange: (k) => { if (p.onTab) p.onTab(k); },
        }),
        tab === 'list'
          ? h(CustomersView, {
            meta: p.meta, board: p.board, busy: p.busy, scanToken: p.scanToken,
            onOpenEngagement: p.onOpenEngagement,
            onRefresh: p.onRefresh,
            onCreate: p.onCreateEngagement,
            onOpenSettings: p.onOpenSettings,
          })
          : h(BoardView, {
            meta: p.meta, board: p.board, busy: p.busy,
            mode: tab === 'board-item' ? 'task' : 'customer',
            search: p.search, onSearch: p.onSearch,
            priority: p.priority, onPriority: p.onPriority,
            customerFilter: p.customerFilter, onCustomerFilter: p.onCustomerFilter,
            onOpenEngagement: p.onOpenEngagement, onOpenItem: p.onOpenItem,
            onMoveEngagement: p.onMoveEngagement,
            onMoveItem: p.onMoveItem,
            onScanNow: p.onScanNow,
            onOpenCustomers: () => { if (p.onTab) p.onTab('list'); },
            onCreateItem: p.onCreateItem,
          }));
    }

    function KnowledgePage(props) {
      const p = props || {};
      const tab = p.tab === 'bids' ? 'bids' : 'library';
      return h('div', { className: 'fde-view fde-view-fill' },
        PageTabs({
          ariaLabel: t('knowledgeTabs'),
          value: tab,
          items: [
            { key: 'library', label: t('tabLibrary') },
            { key: 'bids', label: t('tabBids') },
          ],
          onChange: (k) => { if (p.onTab) p.onTab(k); },
        }),
        tab === 'bids'
          ? h(BidsView, {
            meta: p.meta, board: p.board, bidStats: p.bidStats, busy: p.busy,
            onRefresh: p.onRefresh, onOpenEngagement: p.onOpenEngagement,
          })
          : h(LibraryView, { meta: p.meta }));
    }

    function ProcessPage(props) {
      const p = props || {};
      const tab = p.tab === 'methods' || p.tab === 'skills' ? p.tab : 'flow';
      return h('div', { className: 'fde-view fde-view-fill' },
        PageTabs({
          ariaLabel: t('processTabs'),
          value: tab,
          items: [
            { key: 'flow', label: t('processTabFlow') },
            { key: 'methods', label: t('processTabMethods') },
            { key: 'skills', label: t('processTabSkills') },
          ],
          onChange: (k) => { if (p.onTab) p.onTab(k); },
        }),
        tab === 'flow'
          ? h(ProcessView, {
            meta: p.meta, board: p.board, copyText: p.copyText,
            onOpenMethod: p.onOpenMethod, onOpenLibrary: p.onOpenLibrary,
          })
          : h(MethodsView, {
            meta: p.meta, section: tab,
            initialName: p.initialName, initialSeq: p.initialSeq,
          }));
    }

    function SettingsPage(props) {
      const p = props || {};
      return h('div', { className: 'fde-view' },
        h('div', { className: 'fde-toolbar' },
          h(Btn, { small: true, onClick: p.onBack }, '← ' + t('settingsBack')),
          h('div', { className: 'fde-section-title' }, t('tabSettings'))),
        h(SettingsView, {
          meta: p.meta, board: p.board, busy: p.busy, bidStats: p.bidStats,
          onRefresh: p.onRefresh, onReprobe: p.onReprobe,
          demo: p.demo, demoBusy: p.demoBusy, onDemoRestore: p.onDemoRestore,
        }));
    }

    /* ============================================================
     * 十四、FDE 根组件
     * 状态事实来源是服务端 board：所有写操作后重新拉取 board，
     * 客户端 state 只做渲染与局部编辑草稿。轮询 12s，切页签立即刷新。
     * ============================================================ */
    function FdeApp(props) {
      const p = props || {};
      const actions = (p && p.actions) || {};
      const [meta, setMeta] = useState(p.meta);
      const [board, setBoard] = useState(null);
      const [stats, setStats] = useState(null);
      const [view, setView] = useState(FDE_VIEW_MEM.view);
      useEffect(() => { FDE_VIEW_MEM.view = view; }, [view]);
      /* Phase 2：页内子页签状态（layout.md §7） */
      const [customersTab, setCustomersTab] = useState('board-customer'); /* board-customer | board-item | list */
      const [knowledgeTab, setKnowledgeTab] = useState('library'); /* library | bids */
      const [processTab, setProcessTab] = useState('flow'); /* flow | methods | skills */
      const [settingsReturn, setSettingsReturn] = useState('today');
      const [loading, setLoading] = useState(true);
      const [boardError, setBoardError] = useState('');
      const [brief, setBrief] = useState(null);
      const [briefLoading, setBriefLoading] = useState(false);
      const [briefError, setBriefError] = useState('');
      const [msg, setMsg] = useState(null);
      const [busy, setBusy] = useState('');
      const [drawer, setDrawer] = useState(null);
      const [dialog, setDialog] = useState(null);
      const [createForm, setCreateForm] = useState(null); /* 'engagement' | 'item'（§2.1 新建弹层） */
      const [methodJump, setMethodJump] = useState({ name: '', seq: 0 });
      const [search, setSearch] = useState('');
      const [priority, setPriority] = useState('all');
      const [customerFilter, setCustomerFilter] = useState('');
      const [scanToken, setScanToken] = useState(0);
      const [gateInfo, setGateInfo] = useState(null);
      const [gateLoading, setGateLoading] = useState(false);
      const [gateError, setGateError] = useState('');
      const [drawerFiles, setDrawerFiles] = useState(null);
      const [drawerFilesLoading, setDrawerFilesLoading] = useState(false);
      const [drawerBids, setDrawerBids] = useState(null);
      const [drawerBidsLoading, setDrawerBidsLoading] = useState(false);
      const [drawerBidsError, setDrawerBidsError] = useState('');
      const alive = useRef(true);
      const viewRef = useRef(view);
      const boardRef = useRef(board);
      const drawerRef = useRef(drawer);
      const metaRef = useRef(meta);
      const bidLoadRef = useRef('');
      const [demoBusy, setDemoBusy] = useState(''); /* '' | 'clear' | 'restore'（v1.5.0 演示模式） */

      useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
      useEffect(() => { viewRef.current = view; }, [view]);
      useEffect(() => { boardRef.current = board; }, [board]);
      useEffect(() => { drawerRef.current = drawer; }, [drawer]);
      useEffect(() => { metaRef.current = meta; }, [meta]);

      /* Phase 3（v1.5.0）只读演示覆盖层：今日/客户页用 DEMO 渲染，其它页签保持真实空数据。
         触发见 isDemoEligible()；横幅在壳层常驻，不新增页签/区域。 */
      const demoActive = isDemoEligible(board);
      const demoDismissed = !!(board && board.settings && board.settings.demoDismissed === true);
      const displayBoard = demoActive ? demoBoardView(board, meta) : board;
      const displayBrief = demoActive ? DEMO_BRIEF : brief;

      /* ---------- 读取：board / brief ---------- */
      const loadBoard = useCallback(async (silent) => {
        if (!silent) setLoading(true);
        const r = await fdeGet('/board?view=board');
        if (!alive.current) return;
        if (r && r.ok !== false && r.board) {
          /* board 响应顶层带 root / bidStats（派生字段，不在 board 对象内）；
             合并进客户端 board 视图模型，供工件根路径与设置页招采状态使用。 */
          const nextBoard = Object.assign({}, r.board);
          if (r.root) nextBoard.root = r.root;
          if (r.bidStats) nextBoard.bidStats = r.bidStats;
          setBoard(nextBoard);
          if (r.meta) {
            /* board 响应的 meta 里有 stages/lanes 但没有 skills（skills 只在 GET /fde/meta 带）；
               直接覆盖会把方法页技能清空。合并时保留已有 skills（§2.2）。 */
            const nextMeta = normalizeMeta(r.meta);
            setMeta((prev) => {
              const prevSkills = asList(prev && prev.skills);
              if (asList(nextMeta.skills).length || !prevSkills.length) return nextMeta;
              return Object.assign({}, nextMeta, { skills: prevSkills });
            });
          }
          setStats(r.stats && typeof r.stats === 'object' ? r.stats : computeStats(r.board, normalizeMeta(r.meta || {})));
          setBoardError('');
        } else {
          setBoardError((r && r.reason) || t('boardLoadFail'));
        }
        setLoading(false);
      }, []);

      const loadBrief = useCallback(async () => {
        setBriefLoading(true);
        const r = await fdeGet('/brief');
        if (!alive.current) return;
        setBriefLoading(false);
        if (r && r.ok !== false && r.brief) {
          setBrief(normalizeBrief(r.brief, boardRef.current, metaRef.current));
          setBriefError('');
        } else {
          setBriefError((r && r.reason) || t('briefLoadFail'));
        }
      }, []);

      const refreshAll = useCallback(async (silent) => {
        await loadBoard(silent);
        if (viewRef.current === 'today') await loadBrief();
      }, [loadBoard, loadBrief]);

      useEffect(() => { loadBoard(); }, [loadBoard]);

      /* 轮询：今日只轮 brief，其余视图只轮 board；切页签立刻刷新。
         F-17：页面不可见（document.hidden）时暂停轮询，恢复可见立即补拉一次。 */
      useEffect(() => {
        let stopped = false;
        const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
        const tick = (force) => {
          if (stopped) return;
          if (!force && isHidden()) return;
          if (view === 'today') loadBrief();
          else loadBoard(true);
        };
        tick(true);
        const id = setInterval(() => tick(false), POLL_MS);
        const onVisibility = () => { if (!isHidden()) tick(true); };
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', onVisibility);
        }
        return () => {
          stopped = true;
          clearInterval(id);
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', onVisibility);
          }
        };
      }, [view, loadBoard, loadBrief]);

      /* ---------- 消息 / 错误 ---------- */
      const notify = useCallback((kind, text) => {
        if (!text) return;
        setMsg({ kind, text, at: Date.now() });
      }, []);
      useEffect(() => {
        if (!msg || msg.kind === 'err') return undefined;
        const id = setTimeout(() => { if (alive.current) setMsg(null); }, 6000);
        return () => clearTimeout(id);
      }, [msg]);

      /* 演示态同步给传输层 demoGuard（写请求兜底拦截）；effect 避免渲染期副作用。 */
      useEffect(() => {
        demoRuntime.active = demoActive;
        demoRuntime.notify = notify;
        return () => { demoRuntime.active = false; demoRuntime.notify = null; };
      }, [demoActive, notify]);

      const copyText = useCallback(async (s) => {
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard) {
            await navigator.clipboard.writeText(s);
            return true;
          }
        } catch (e) { /* ignore */ }
        return false;
      }, []);

      const gotoSession = useCallback((sessionId) => {
        if (!sessionId || typeof actions.openSession !== 'function') return;
        /* openSession 宿主契约是 void，不按返回值重试（§2.5）；失败由宿主/布局自行兜底。 */
        try { actions.openSession(sessionId); } catch (e) { /* ignore */ }
      }, [actions]);

      /* ---------- 变更：统一 busy + 失败行内提示 ---------- */
      const runAction = demoGuard(useCallback(async (busyKey, fn) => {
        setBusy(busyKey);
        let r;
        try { r = await fn(); } catch (e) { r = { ok: false, reason: errText(e) }; }
        if (!alive.current) return r;
        setBusy('');
        if (r && r.ok === false) notify('err', r.reason || t('actionFail'));
        return r;
      }, [notify]));

      /* ---------- 演示模式：一键清除 / 重新查看（ADR 0006 D2） ---------- */
      const dismissDemo = useCallback(async () => {
        setDemoBusy('clear');
        /* 这是演示模式下唯一允许的设置写入：显式绕过 demoGuard（用户主动清除示例）。 */
        const r = await postJSON(FDE + '/settings', { patch: { demoDismissed: true } }, 15000, { demoBypass: true });
        if (!alive.current) return;
        setDemoBusy('');
        if (r && r.ok !== false) {
          notify('ok', t('demoCleared'));
          await refreshAll(true);
        } else {
          notify('err', (r && r.reason) || t('demoClearFail'));
        }
      }, [notify, refreshAll]);

      const restoreDemo = useCallback(async () => {
        if (!isBoardEmpty(boardRef.current)) { notify('warn', t('demoRestoreBlocked')); return; }
        setDemoBusy('restore');
        const r = await postJSON(FDE + '/settings', { patch: { demoDismissed: false } }, 15000, { demoBypass: true });
        if (!alive.current) return;
        setDemoBusy('');
        if (r && r.ok !== false) {
          notify('ok', t('demoRestored'));
          await refreshAll(true);
        } else {
          notify('err', (r && r.reason) || t('demoClearFail'));
        }
      }, [notify, refreshAll]);

      /* ---------- 抽屉 ---------- */
      const openEngagement = useCallback((id) => {
        setDrawer({ type: 'engagement', id });
        setGateInfo(null); setGateError(''); setDrawerFiles(null);
        setDrawerBids(null); setDrawerBidsLoading(false); setDrawerBidsError('');
        bidLoadRef.current = '';
      }, []);
      const openItem = useCallback((id) => { setDrawer({ type: 'item', id }); }, []);
      const closeDrawer = useCallback(() => setDrawer(null), []);

      /* 新建客户 / 新建任务（§2.1）：成功后刷新 board，再打开新对象抽屉 */
      /* 演示态下新建入口直接拦截（不打开弹层），行内提示走 demoGuard。 */
      const openCreate = demoGuard(useCallback((kind) => setCreateForm(kind === 'item' ? 'item' : 'engagement'), []));
      const submitCreate = useCallback(async (kind, payload) => {
        const path = kind === 'item' ? '/item' : '/engagement';
        return runAction('create-' + kind, () => fdePost(path, { action: 'create', patch: payload }));
      }, [runAction]);
      const afterCreate = useCallback(async (kind, r) => {
        setCreateForm(null);
        const obj = kind === 'item' ? (r && r.item) : (r && r.engagement);
        notify('ok', (kind === 'item' ? '已创建任务：' : '已创建客户：') + ((obj && (obj.title || obj.name)) || ''));
        await refreshAll(true);
        if (!obj || !obj.id) return;
        if (kind === 'item') openItem(obj.id); else openEngagement(obj.id);
      }, [notify, refreshAll, openItem, openEngagement]);

      const drawerEngagement = drawer && drawer.type === 'engagement' ? findEngagement(displayBoard, drawer.id) : null;
      const drawerItem = drawer && drawer.type === 'item' ? findItem(displayBoard, drawer.id) : null;

      useEffect(() => {
        if (!drawer) return;
        if (drawer.type === 'engagement' && !drawerEngagement && board) setDrawer(null);
        if (drawer.type === 'item' && !drawerItem && board) setDrawer(null);
      }, [drawer, drawerEngagement, drawerItem, board]);

      const loadDrawerFiles = useCallback(async (eng) => {
        const target = eng || drawerEngagement;
        if (!target || !target.dir) { setDrawerFiles([]); return; }
        setDrawerFilesLoading(true);
        const r = await getJSON(API + '/files?dir=' + encodeURIComponent(target.dir));
        if (!alive.current) return;
        setDrawerFilesLoading(false);
        if (r && r.ok !== false && Array.isArray(r.files)) setDrawerFiles(r.files);
        else { setDrawerFiles([]); notify('warn', '工件读取失败：' + ((r && r.reason) || '未知原因')); }
      }, [drawerEngagement, notify]);

      useEffect(() => {
        if (drawer && drawer.type === 'engagement' && drawerEngagement && drawerFiles === null) {
          loadDrawerFiles(drawerEngagement);
        }
      }, [drawer, drawerEngagement, drawerFiles, loadDrawerFiles]);

      /* ---------- 招采雷达（v1.1）：客户关联层数据与写操作 ---------- */
      const drawerBidsTarget = useCallback(() => {
        const d = drawerRef.current;
        return d && d.type === 'engagement' ? findEngagement(boardRef.current, d.id) : null;
      }, []);

      const loadDrawerBids = useCallback(async (target, refresh) => {
        const eng = target || drawerBidsTarget();
        if (!eng || !eng.id) return;
        setDrawerBidsLoading(true); setDrawerBidsError('');
        const r = await fdeGet('/bids/match?engagementId=' + encodeURIComponent(eng.id) + (refresh ? '&refresh=1' : ''));
        if (!alive.current) return;
        setDrawerBidsLoading(false);
        if (r && r.ok === false && r.available !== false) {
          setDrawerBidsError(r.reason || t('loadFail'));
          return;
        }
        setDrawerBids(normalizeBidMatchResp(r));
      }, [drawerBidsTarget]);

      useEffect(() => {
        if (!drawer || drawer.type !== 'engagement' || !drawerEngagement) return;
        if (drawerBids !== null) return;
        if (bidLoadRef.current === drawerEngagement.id) return;
        bidLoadRef.current = drawerEngagement.id;
        loadDrawerBids(drawerEngagement, false);
      }, [drawer, drawerEngagement, drawerBids, loadDrawerBids]);

      const afterBidWrite = useCallback(async () => {
        await refreshAll(true);
        const eng = drawerBidsTarget();
        if (eng) await loadDrawerBids(eng, false);
      }, [refreshAll, drawerBidsTarget, loadDrawerBids]);

      const linkBid = useCallback(async (item) => {
        const eng = drawerBidsTarget();
        if (!eng || !item || !item.id) return null;
        const r = await runAction('bid-link:' + item.id, () => fdePost('/bids/link', {
          engagementId: eng.id, bidId: item.id, relation: str(item.relation || ''), note: '',
        }));
        if (r && r.available === false) { notify('warn', r.reason || t('bidNotReady')); return r; }
        if (r && r.ok) { notify('ok', t('bidLinkOk')); await afterBidWrite(); }
        return r;
      }, [runAction, notify, afterBidWrite, drawerBidsTarget]);

      const unlinkBid = useCallback(async (link) => {
        const eng = drawerBidsTarget();
        if (!eng || !link || !link.bidId) return null;
        const r = await runAction('bid-unlink:' + link.bidId, () => fdePost('/bids/unlink', {
          engagementId: eng.id, bidId: link.bidId,
        }));
        if (r && r.available === false) { notify('warn', r.reason || t('bidNotReady')); return r; }
        if (r && r.ok) { notify('ok', t('bidUnlinkOk')); await afterBidWrite(); }
        return r;
      }, [runAction, notify, afterBidWrite, drawerBidsTarget]);

      const promoteBid = useCallback(async (item) => {
        const eng = drawerBidsTarget();
        if (!eng || !item || !item.id) return null;
        const r = await runAction('bid-promote:' + item.id, () => fdePost('/bids/promote', {
          engagementId: eng.id, bidId: item.id,
        }));
        if (r && r.available === false) { notify('warn', r.reason || t('bidNotReady')); return r; }
        if (r && r.ok) {
          const title = str(r.item && r.item.title);
          notify('ok', t('bidPromoteOk') + (title ? '：' + title : ''));
          await afterBidWrite();
        }
        return r;
      }, [runAction, notify, afterBidWrite, drawerBidsTarget]);

      const refreshDrawerBids = useCallback(async () => {
        const eng = drawerBidsTarget();
        if (!eng) return;
        const r = await runAction('bid-refresh', () => fdePost('/bids/refresh', { engagementId: eng.id }));
        if (r && r.available === false) {
          setDrawerBids(normalizeBidMatchResp(r));
          notify('warn', r.reason || t('bidNotReady'));
          return;
        }
        if (r && r.ok !== false) {
          setDrawerBids(normalizeBidMatchResp(r));
          notify('ok', t('bidRefreshOk'));
          await refreshAll(true);
        }
      }, [runAction, refreshAll, notify, drawerBidsTarget]);

      const toggleBidWatch = useCallback(async (enabled) => {
        const eng = drawerBidsTarget();
        if (!eng) return;
        const base = eng.bidWatch && typeof eng.bidWatch === 'object' ? eng.bidWatch : {};
        const r = await runAction('bid-watch', () => fdePost('/engagement', {
          action: 'update', id: eng.id, patch: { bidWatch: Object.assign({}, base, { enabled: !!enabled }) },
        }));
        if (r && r.ok) {
          await refreshAll(true);
          notify('ok', t('bidWatchLabel') + (enabled ? ' 已开启' : ' 已关闭'));
        }
      }, [runAction, refreshAll, notify, drawerBidsTarget]);

      const drawerFilesBase = (() => {
        if (!drawerEngagement) return '';
        if (drawerEngagement.path) return str(drawerEngagement.path);
        const root = str(board && board.root);
        return root && drawerEngagement.dir ? root.replace(/\/+$/, '') + '/research/' + drawerEngagement.dir : '';
      })();

      /* ---------- 会话交接 ---------- */
      const handoff = useCallback(async (type, id) => {
        const r = await runAction('handoff', () => fdePost('/handoff', { target: type, id }));
        if (!r) return;
        if (r.ok && r.sessionId) {
          notify('ok', t('drawerHandoffPrompt'));
          await refreshAll(true);
          gotoSession(r.sessionId);
          return;
        }
        const prompt = str(r.prompt || '');
        const copied = prompt ? await copyText(prompt) : false;
        notify('warn', (r.reason || t('noSession')) + (copied ? ' ' + t('copied') : ''));
      }, [runAction, notify, copyText, refreshAll, gotoSession]);

      /* ---------- 阶段移动 + 门禁 ---------- */
      const doMoveEngagement = useCallback(async (id, toStage, body) => {
        const eng = findEngagement(boardRef.current, id);
        if (!eng) return null;
        const fromIdx = stageIndex(metaRef.current, eng.stage);
        const toIdx = stageIndex(metaRef.current, toStage);
        if (toIdx !== -1 && fromIdx !== -1 && toIdx < fromIdx) {
          setDialog({
            title: t('drawerMoveBackConfirm'),
            body: t('drawerMoveBackBody') + ' 目标：' + stageLabel(metaRef.current, toStage) + '。',
            confirmLabel: '回退',
            onConfirm: async () => {
              setDialog(null);
              const r = await runAction('move:' + id, () => fdePost('/engagement', { action: 'move', id, patch: { stage: toStage } }));
              if (r && r.ok) { await refreshAll(true); notify('ok', '已回退到「' + stageLabel(metaRef.current, toStage) + '」'); }
            },
          });
          return null;
        }
        const r = await runAction('move:' + id, () => fdePost('/engagement', { action: 'move', id, patch: Object.assign({ stage: toStage }, body || {}) }));
        if (!r) return null;
        if (r.ok) {
          await refreshAll(true);
          notify('ok', '已推进到「' + stageLabel(metaRef.current, toStage) + '」');
          return r;
        }
        if (r.blocked || asList(r.missing).length) {
          setDialog({
            title: t('drawerGateMissingTitle'),
            body: '目标阶段：' + stageLabel(metaRef.current, toStage) + '。门禁未通过，是否强制推进？',
            children: h(MissingList, { items: r.missing }),
            confirmLabel: '强制推进（填写理由）',
            danger: true,
            onCancel: () => { setDialog(null); openEngagement(id); },
            onConfirm: () => {
              setDialog({
                title: t('drawerForceTitle'),
                body: t('drawerForceBody'),
                danger: true,
                input: { label: t('drawerForceReason'), placeholder: '写清为什么绕过门禁（会记录在 timeline）', required: true, multiline: true },
                confirmLabel: '确认强制推进',
                onConfirm: async (reason) => {
                  setDialog(null);
                  const r2 = await runAction('force:' + id, () => fdePost('/engagement', {
                    action: 'move', id, patch: { stage: toStage, force: true, reason: reason || '面板强制推进' },
                  }));
                  if (r2 && r2.ok) { await refreshAll(true); notify('warn', '已强制推进到「' + stageLabel(metaRef.current, toStage) + '」，已记录人工覆盖。'); }
                },
              });
            },
          });
        }
        return r;
      }, [runAction, refreshAll, notify, openEngagement]);

      const moveItem = useCallback(async (id, laneKey) => {
        const r = await runAction('move-item:' + id, () => fdePost('/item', { action: 'move', id, patch: { stage: laneKey } }));
        if (!r) return null;
        if (r.ok) {
          await refreshAll(true);
          notify('ok', '已移动到「' + laneLabel(metaRef.current, laneKey) + '」');
          return r;
        }
        if (r.blocked || asList(r.missing).length || /证据/.test(str(r.reason))) {
          setDialog({
            title: t('drawerEvidenceTitle'),
            body: t('drawerEvidenceBody'),
            input: { label: t('drawerEvidenceLabel'), placeholder: '写清结果与可检查的产物路径', required: true, multiline: true },
            confirmLabel: '带证据移动',
            onCancel: () => setDialog(null),
            onConfirm: async (evidence) => {
              setDialog(null);
              const r2 = await runAction('move-item:' + id, () => fdePost('/item', {
                action: 'move', id, patch: { stage: laneKey, evidence, force: true, reason: evidence },
              }));
              if (r2 && r2.ok) { await refreshAll(true); notify('ok', '已移动到「' + laneLabel(metaRef.current, laneKey) + '」'); }
            },
          });
        }
        return r;
      }, [runAction, refreshAll, notify]);

      const evaluateGate = useCallback(async (stageKey) => {
        const d = drawerRef.current;
        if (!d || d.type !== 'engagement') return;
        setGateLoading(true); setGateError('');
        const r = await fdePost('/gate', { engagementId: d.id, stage: stageKey });
        if (!alive.current) return;
        setGateLoading(false);
        if (r && (r.gate || r.ok !== false)) {
          setGateInfo({ stage: stageKey, gate: r.gate || null, missing: asList(r.missing), at: Date.now() });
        } else {
          setGateError((r && r.reason) || '门禁评估失败');
        }
      }, []);

      const saveGate = useCallback(async (stageKey, checks) => {
        const d = drawerRef.current;
        if (!d) return;
        const r = await runAction('gate', () => fdePost('/gate', { engagementId: d.id, stage: stageKey, checks }));
        if (r && r.ok !== false) {
          setGateInfo({ stage: stageKey, gate: r.gate || null, missing: asList(r.missing), at: Date.now() });
          await refreshAll(true);
          notify('ok', '人工确认已保存');
        }
      }, [runAction, refreshAll, notify]);

      const forceGate = useCallback((stageKey) => {
        const d = drawerRef.current;
        if (!d) return;
        setDialog({
          title: t('drawerForceTitle'),
          body: t('drawerForceBody') + ' 门禁：' + stageLabel(metaRef.current, stageKey) + '。',
          danger: true,
          input: { label: t('drawerForceReason'), placeholder: '写清为什么绕过门禁（会记录人工覆盖）', required: true, multiline: true },
          confirmLabel: '强制通过并推进',
          onCancel: () => setDialog(null),
          onConfirm: async (reason) => {
            setDialog(null);
            const r = await runAction('gate-force', () => fdePost('/gate', {
              engagementId: d.id, stage: stageKey, force: true, reason: reason || '面板强制通过',
            }));
            if (r && r.ok !== false) {
              const r2 = await runAction('move:' + d.id, () => fdePost('/engagement', {
                action: 'move', id: d.id, patch: { stage: stageKey },
              }));
              if (r2 && r2.ok) {
                await refreshAll(true);
                notify('warn', '已强制通过门禁并推进到「' + stageLabel(metaRef.current, stageKey) + '」。');
              }
            }
          },
        });
      }, [runAction, refreshAll, notify]);

      /* ---------- 客户字段 / 生命周期 ---------- */
      const saveNext = useCallback(async (next) => {
        const d = drawerRef.current;
        if (!d) return;
        const r = await runAction('next', () => fdePost('/engagement', {
          action: 'update', id: d.id, patch: { nextAction: { text: next.text, due: next.due, owner: next.owner } },
        }));
        if (r && r.ok) { await refreshAll(true); notify('ok', '下一步已保存'); }
      }, [runAction, refreshAll, notify]);

      const saveStakeholders = useCallback(async (list) => {
        const d = drawerRef.current;
        if (!d) return { ok: false };
        const r = await runAction('stake', () => fdePost('/engagement', { action: 'update', id: d.id, patch: { stakeholders: list } }));
        if (r && r.ok) { await refreshAll(true); notify('ok', '干系人已保存'); }
        return r;
      }, [runAction, refreshAll, notify]);

      const pauseEngagement = useCallback(async (paused) => {
        const d = drawerRef.current;
        if (!d) return;
        const r = await runAction('pause', () => fdePost('/engagement', { action: 'update', id: d.id, patch: { paused: !!paused } }));
        if (r && r.ok) { await refreshAll(true); notify('ok', paused ? '已暂停' : '已恢复'); }
      }, [runAction, refreshAll, notify]);

      const archiveEngagement = useCallback(() => {
        const d = drawerRef.current;
        if (!d) return;
        setDialog({
          title: t('drawerArchiveConfirm'),
          body: t('drawerArchiveBody'),
          danger: true,
          confirmLabel: t('drawerArchive'),
          onCancel: () => setDialog(null),
          onConfirm: async () => {
            setDialog(null);
            const r = await runAction('archive', () => fdePost('/engagement', { action: 'archive', id: d.id }));
            if (r && r.ok) {
              setDrawer(null);
              await refreshAll(true);
              notify('ok', '已归档（目录与文件未删除）');
            }
          },
        });
      }, [runAction, refreshAll, notify]);

      /* ---------- 任务 ---------- */
      const saveItem = useCallback(async (payload) => {
        const d = drawerRef.current;
        if (!d) return { ok: false };
        const patch = (payload && payload.patch) || {};
        const lane = str(payload && payload.lane);
        const before = findItem(boardRef.current, d.id);
        const r = await runAction('item-save', () => fdePost('/item', { action: 'update', id: d.id, patch }));
        if (!r || !r.ok) return r;
        if (lane && before && lane !== before.stage) {
          const rMove = await moveItem(d.id, lane);
          return rMove || r;
        }
        await refreshAll(true);
        return r;
      }, [runAction, refreshAll, moveItem]);

      const reportItem = useCallback(async (kind, text) => {
        const d = drawerRef.current;
        if (!d) return;
        const r = await runAction('report', () => fdePost('/item', { action: 'report', id: d.id, kind, text }));
        if (r && r.ok) { await refreshAll(true); notify('ok', '回报已记录'); }
      }, [runAction, refreshAll, notify]);

      const deleteItem = useCallback(() => {
        const d = drawerRef.current;
        if (!d) return;
        setDialog({
          title: t('drawerDeleteConfirm'),
          body: t('drawerDeleteBody'),
          danger: true,
          confirmLabel: t('drawerDelete'),
          onCancel: () => setDialog(null),
          onConfirm: async () => {
            setDialog(null);
            const r = await runAction('item-del', () => fdePost('/item', { action: 'delete', id: d.id }));
            if (r && r.ok) { setDrawer(null); await refreshAll(true); notify('ok', '任务已删除'); }
          },
        });
      }, [runAction, refreshAll, notify]);

      const resolveAttention = useCallback(async (target, id, answer) => {
        const r = await runAction('attn', () => fdePost('/attention', { action: 'resolve', target, id, answer: answer || '' }));
        if (r && r.ok) { await refreshAll(true); notify('ok', '已解决'); }
        return r;
      }, [runAction, refreshAll, notify]);

      /* ---------- 今日：注意力动作 ---------- */
      const attentionOpen = useCallback((a) => {
        if (a.itemId) return openItem(a.itemId);
        if (a.engagementId) return openEngagement(a.engagementId);
        return null;
      }, [openItem, openEngagement]);

      const askAnswer = useCallback((a, target, id) => {
        setDialog({
          title: t('actAnswer'),
          body: a.text,
          input: { label: t('drawerAnswerPh'), placeholder: '回答会记录到 attention 记录里', required: false, multiline: true },
          confirmLabel: t('actResolve'),
          onCancel: () => setDialog(null),
          onConfirm: async (answer) => { setDialog(null); await resolveAttention(target, id, answer); },
        });
      }, [resolveAttention]);

      const moveToDoneLane = useCallback((itemId) => {
        const lanes = asList(metaRef.current && metaRef.current.boardLanes);
        const last = lanes.length ? lanes[lanes.length - 1].key : '';
        return last ? moveItem(itemId, last) : null;
      }, [moveItem]);

      const attentionAction = useCallback(async (a, key) => {
        const target = a.itemId ? 'item' : 'engagement';
        const id = a.itemId || a.engagementId;
        if (key === 'open') return attentionOpen(a);
        if (key === 'accept' || key === 'dismiss') {
          if (a.proposalId) {
            const r = await runAction('prp:' + a.proposalId, () => fdePost('/proposal', { id: a.proposalId, action: key }));
            if (r && r.ok) { await refreshAll(true); notify('ok', key === 'accept' ? '已采纳建议' : '已忽略建议'); }
            return null;
          }
          /* 非 proposal 的 accept（如 decision）视为已确认并解决 */
          if (key === 'accept' && id) return resolveAttention(target, id, '已确认');
          return null;
        }
        if (key === 'resolve') {
          if (!id) return null;
          if (a.kind === 'decision' || a.kind === 'answer') { askAnswer(a, target, id); return null; }
          return resolveAttention(target, id, '');
        }
        if (key === 'answer') {
          if (!id) return null;
          askAnswer(a, target, id);
          return null;
        }
        if (key === 'pass' || key === 'done' || key === 'finish') {
          if (a.itemId) return moveToDoneLane(a.itemId);
          return attentionOpen(a);
        }
        if (key === 'pause') {
          if (!a.engagementId) return null;
          const r = await runAction('pause:' + a.engagementId, () => fdePost('/engagement', {
            action: 'update', id: a.engagementId, patch: { paused: true },
          }));
          if (r && r.ok) { await refreshAll(true); notify('ok', '已暂停该客户'); }
          return null;
        }
        /* return/reschedule/confirm/followup 等：打开抽屉由人处理（不自动改阶段/日期） */
        return attentionOpen(a);
      }, [attentionOpen, runAction, refreshAll, notify, resolveAttention, moveItem, moveToDoneLane, askAnswer]);

      const proposalAction = useCallback(async (pr, action) => {
        const r = await runAction('prp:' + pr.id, () => fdePost('/proposal', { id: pr.id, action }));
        if (r && r.ok) { await refreshAll(true); notify('ok', action === 'accept' ? '已采纳建议' : '已忽略建议'); }
      }, [runAction, refreshAll, notify]);

      /* 演示态下所有写入口再包一层 demoGuard（ADR 0006 D1）：点击即给行内提示，
         不弹确认框、不乐观更新；传输层 demoGuard 仍作为最后防线。 */
      const guarded = {
        moveEngagement: demoGuard(doMoveEngagement),
        moveItem: demoGuard(moveItem),
        evaluateGate: demoGuard(evaluateGate),
        saveGate: demoGuard(saveGate),
        forceGate: demoGuard(forceGate),
        saveNext: demoGuard(saveNext),
        saveStakeholders: demoGuard(saveStakeholders),
        pauseEngagement: demoGuard(pauseEngagement),
        archiveEngagement: demoGuard(archiveEngagement),
        saveItem: demoGuard(saveItem),
        reportItem: demoGuard(reportItem),
        deleteItem: demoGuard(deleteItem),
        handoff: demoGuard(handoff),
        linkBid: demoGuard(linkBid),
        unlinkBid: demoGuard(unlinkBid),
        promoteBid: demoGuard(promoteBid),
        toggleBidWatch: demoGuard(toggleBidWatch),
        attentionAction: demoGuard(attentionAction),
        proposalAction: demoGuard(proposalAction),
        resolveAttention: demoGuard(resolveAttention),
      };

      /* ---------- 视图导航（Phase 2：5 页签 + 页内子页签；旧 key 映射，不白屏） ---------- */
      const goView = useCallback((key) => {
        const k = str(key);
        if (k === 'settings') {
          setSettingsReturn((prev) => (viewRef.current && viewRef.current !== 'settings' ? viewRef.current : prev));
          setView('settings');
          setMsg(null);
          return;
        }
        if (k === 'board') setCustomersTab('board-customer');
        else if (k === 'library') setKnowledgeTab('library');
        else if (k === 'bids') setKnowledgeTab('bids');
        else if (k === 'methods') setProcessTab('methods');
        setView(normalizeView(k));
        setMsg(null);
      }, []);

      const openSettings = useCallback(() => { goView('settings'); }, [goView]);
      const closeSettings = useCallback(() => {
        const back = normalizeView(settingsReturn && settingsReturn !== 'settings' ? settingsReturn : 'today');
        setView(back);
        setMsg(null);
      }, [settingsReturn]);

      /* 流程页 → 方法库/技能与模板正文：seq 递增保证同一文件可再次触发打开 */
      const openMethod = useCallback((name, kind) => {
        const nm = str(name);
        if (!nm) return;
        setMethodJump((prev) => ({ name: nm, seq: ((prev && prev.seq) || 0) + 1 }));
        setProcessTab(kind === 'template' ? 'skills' : 'methods');
        setView('process');
        setMsg(null);
      }, []);

      const openLibrary = useCallback(() => {
        setKnowledgeTab('library');
        setView('knowledge');
        setMsg(null);
      }, []);

      const openCustomersList = useCallback(() => {
        setCustomersTab('list');
        setView('customers');
        setMsg(null);
      }, []);

      const startScan = useCallback(() => {
        setCustomersTab('list');
        setView('customers');
        setScanToken((n) => n + 1);
      }, []);

      /* ---------- 统计（服务端优先，缺失时本地派生的只读口径） ---------- */
      const localStats = computeStats(board, meta);
      const todayStats = demoActive
        ? { active: DEMO_BRIEF.stats.active, dueToday: DEMO_BRIEF.stats.dueToday, overdue: DEMO_BRIEF.stats.overdue }
        : {
          active: stats && typeof stats.active === 'number' ? stats.active : localStats.active,
          dueToday: stats && typeof stats.dueToday === 'number' ? stats.dueToday : localStats.dueToday,
          overdue: stats && typeof stats.overdue === 'number' ? stats.overdue : localStats.overdue,
        };
      const attentionCount = asList(displayBrief && displayBrief.attention).length;
      const activeCount = todayStats.active || 0;
      const engCount = asList(board && board.engagements).length;

      /* Phase 2 IA（layout.md §7）：5 页签 + 页头设置入口；旧 view 值由 normalizeView 回落 */
      const activeView = normalizeView(view);
      const activeCustomersTab = ['board-customer', 'board-item', 'list'].indexOf(customersTab) !== -1 ? customersTab : 'board-customer';
      const activeKnowledgeTab = knowledgeTab === 'bids' ? 'bids' : 'library';
      const activeProcessTab = ['flow', 'methods', 'skills'].indexOf(processTab) !== -1 ? processTab : 'flow';
      const navItems = [
        { key: 'today', label: t('tabToday'), count: attentionCount || null },
        { key: 'customers', label: t('tabCustomers'), count: null },
        { key: 'files', label: t('tabNavFiles'), count: null },
        { key: 'process', label: t('tabProcess'), count: null },
        { key: 'knowledge', label: t('tabKnowledge'), count: null },
      ];

      const viewNode = () => {
        if (!board) {
          if (loading) return h(Loading, { text: '正在读取 FDE 看板…' });
          return h(ErrorLine, {
            title: t('boardLoadFail'), text: boardError || t('retryHint'),
            onRetry: () => loadBoard(),
          });
        }
        if (activeView === 'customers') {
          return h(CustomersPage, {
            tab: activeCustomersTab, onTab: setCustomersTab,
            meta, board: displayBoard, busy, scanToken,
            search, onSearch: setSearch,
            priority, onPriority: setPriority,
            customerFilter, onCustomerFilter: setCustomerFilter,
            onRefresh: () => refreshAll(false),
            onOpenEngagement: openEngagement, onOpenItem: openItem,
            onMoveEngagement: (id, stage) => guarded.moveEngagement(id, stage),
            onMoveItem: guarded.moveItem,
            onScanNow: startScan, onOpenCustomers: () => goView('customers'),
            onCreateEngagement: () => openCreate('engagement'),
            onCreateItem: () => openCreate('item'),
            onOpenSettings: openSettings,
          });
        }
        if (activeView === 'knowledge') {
          return h(KnowledgePage, {
            tab: activeKnowledgeTab, onTab: setKnowledgeTab,
            meta, board, busy,
            bidStats: normalizeBoardBidStats(board),
            onRefresh: () => refreshAll(false),
            onOpenEngagement: openEngagement,
          });
        }
        if (activeView === 'process') {
          return h(ProcessPage, {
            tab: activeProcessTab, onTab: setProcessTab,
            meta, board, copyText,
            onOpenMethod: openMethod, onOpenLibrary: openLibrary,
            initialName: methodJump.name, initialSeq: methodJump.seq,
          });
        }
        if (activeView === 'files') {
          return h(ArtifactsView, {
            meta, board, busy,
            root: str(board.root),
            onNotify: notify,
            onOpenCustomers: openCustomersList,
            onOpenPath: actions.openPath,
            openPath: actions.openPath,
            openSession: actions.openSession,
            services: actions.services || {},
            copyText,
            onScanNow: startScan,
            onRefresh: () => refreshAll(false),
          });
        }
        if (activeView === 'settings') {
          return h(SettingsPage, {
            meta, board, busy,
            bidStats: normalizeBoardBidStats(board),
            onRefresh: () => refreshAll(false),
            onReprobe: p.onReprobe,
            onBack: closeSettings,
            demo: { active: demoActive, dismissed: demoDismissed, empty: isBoardEmpty(board) },
            demoBusy,
            onDemoRestore: restoreDemo,
          });
        }
        return h(TodayView, {
          meta, board: displayBoard, brief: displayBrief, stats: todayStats,
          briefLoading, briefError,
          busy,
          onRefresh: () => refreshAll(false),
          onRefreshBrief: loadBrief,
          onOpenEngagement: openEngagement,
          onOpenItem: openItem,
          onAttentionOpen: attentionOpen,
          onAttentionAction: guarded.attentionAction,
          onProposalAction: guarded.proposalAction,
          onScanNow: startScan,
          onCustomers: openCustomersList,
          onCreate: () => openCreate('engagement'),
          onOpenSettings: openSettings,
        });
      };

      /* ---------- 渲染 ---------- */
      const autonomy = autonomyKey(meta, board);
      return h('div', { className: 'fde-root' },
        h('div', { className: 'fde-top' },
          h('div', { className: 'fde-top-left' },
            h('div', { className: 'fde-title' }, t('fdeBrand')),
            /* 页头只留标语；活跃客户/待处理数字由「今日」统计条与页签角标各自承担一处（§2.6） */
            h('div', { className: 'fde-subtitle' }, t('fdeTagline'))),
          h('div', { className: 'fde-top-right' },
            AutonomyBadge({ meta, mode: autonomy }),
            h(Btn, { small: true, onClick: () => refreshAll(false), disabled: !!busy, busy: loading && !board }, t('refresh')),
            h('button', {
              type: 'button',
              className: 'fde-iconbtn' + (activeView === 'settings' ? ' on' : ''),
              title: t('tabSettings'),
              'aria-label': t('tabSettings'),
              'aria-pressed': activeView === 'settings' ? 'true' : 'false',
              onClick: activeView === 'settings' ? closeSettings : openSettings,
            }, '⚙'))),
        h('div', { className: 'fde-nav-wrap' },
          h('div', { className: 'fde-nav', role: 'tablist', 'aria-label': 'FDE 视图' },
            navItems.map((n) => h('button', {
              key: n.key,
              type: 'button',
              role: 'tab',
              'aria-selected': activeView === n.key ? 'true' : 'false',
              className: activeView === n.key ? 'on' : '',
              onClick: () => goView(n.key),
            }, n.label, n.count ? h('span', { className: 'fde-cnt' }, String(n.count)) : null)))),
        demoActive ? h('div', { className: 'fde-demo-banner', role: 'status', 'aria-live': 'polite' },
          h('span', { className: 'fde-demo-badge' }, t('demoBadge')),
          h('span', { className: 'fde-demo-banner-text' }, t('demoBannerText')),
          h('div', { className: 'fde-spacer' }),
          h(Btn, {
            small: true, kind: 'primary',
            busy: demoBusy === 'clear',
            onClick: dismissDemo,
          }, demoBusy === 'clear' ? t('demoClearing') : t('demoStart')),
          h(Btn, { small: true, onClick: () => goView('process') }, t('demoLearn'))) : null,
        msg ? h('div', { style: { padding: '0 18px' } },
          h(MsgLine, { kind: msg.kind, text: msg.text, onClose: () => setMsg(null) })) : null,
        h('div', { className: 'fde-main' }, viewNode()),
        h('div', { className: 'fde-live', 'aria-live': 'polite', 'aria-atomic': 'true' }, msg ? msg.text : ''),
        /* 抽屉 */
        drawer && drawerEngagement && drawer.type === 'engagement'
          ? h(EngagementDrawer, {
            key: 'eng-' + drawerEngagement.id,
            meta, board: displayBoard,
            engagement: drawerEngagement,
            gateInfo, gateLoading, gateError,
            files: drawerFiles, filesLoading: drawerFilesLoading, filesBase: drawerFilesBase,
            bids: drawerBids, bidsLoading: drawerBidsLoading, bidsError: drawerBidsError, bidBusy: busy,
            onBidsRefresh: refreshDrawerBids,
            onBidLink: guarded.linkBid, onBidUnlink: guarded.unlinkBid, onBidPromote: guarded.promoteBid,
            onToggleBidWatch: guarded.toggleBidWatch,
            onClose: closeDrawer,
            onMoveStage: (stage) => guarded.moveEngagement(drawerEngagement.id, stage),
            onMoveBack: (stage) => guarded.moveEngagement(drawerEngagement.id, stage),
            onGateEvaluate: guarded.evaluateGate,
            onGateSave: guarded.saveGate,
            onForceGate: guarded.forceGate,
            onSaveNext: guarded.saveNext,
            onSaveStakeholders: guarded.saveStakeholders,
            onLoadFiles: () => loadDrawerFiles(drawerEngagement),
            onHandoff: () => guarded.handoff('engagement', drawerEngagement.id),
            onPause: guarded.pauseEngagement,
            onArchive: guarded.archiveEngagement,
            onOpenItem: openItem,
            onOpenPath: actions.openPath,
          })
          : null,
        drawer && drawerItem && drawer.type === 'item'
          ? h(ItemDrawer, {
            key: 'itm-' + drawerItem.id,
            meta, board: displayBoard,
            item: drawerItem,
            onClose: closeDrawer,
            onSave: guarded.saveItem,
            onReport: guarded.reportItem,
            onDelete: guarded.deleteItem,
            onHandoff: () => guarded.handoff('item', drawerItem.id),
            onOpenSession: gotoSession,
            onResolveAttention: guarded.resolveAttention,
          })
          : null,
        /* 新建客户 / 任务弹层（§2.1） */
        createForm
          ? h(CreateDialog, {
            kind: createForm,
            meta,
            board,
            onSubmit: (payload) => submitCreate(createForm, payload),
            onCreated: (r) => afterCreate(createForm, r),
            onClose: () => setCreateForm(null),
          })
          : null,
        /* 确认 / 强制 / 证据弹层 */
        dialog
          ? h(ConfirmDialog, Object.assign({}, dialog, {
            busy: !!busy,
            onCancel: dialog.onCancel || (() => setDialog(null)),
            onConfirm: (value) => { if (dialog.onConfirm) dialog.onConfirm(value); },
          }))
          : null);
    }

    /* ============================================================
     * 十五、宿主未就绪页 / 根组件 / 注册
     * 启动先探测 GET /fde/meta：成功进主面板；失败显示精简的
     * 「宿主未就绪」页（只给重试与重启说明），任何分支都不白屏。
     * ============================================================ */
    function CompatPage(props) {
      const p = props || {};
      return h('div', { className: 'fde-root' },
        h('div', { className: 'fde-top' },
          h('div', { className: 'fde-top-left' },
            h('div', { className: 'fde-title' }, t('fdeBrand')),
            h('div', { className: 'fde-subtitle' }, t('fdeTagline'))),
          h('div', { className: 'fde-top-right' },
            h(Btn, { small: true, onClick: p.onRetry }, t('compatRetry')))),
        h('div', { className: 'fde-compat' },
          h('div', { className: 'fde-compat-card', role: 'alert' },
            h('div', { className: 'fde-compat-title' },
              h('span', { className: 'fde-compat-mark', 'aria-hidden': 'true' }, '!'),
              h('span', null, t('compatTitle'))),
            h('div', { className: 'fde-compat-body' },
              h('div', null, t('compatBody')),
              h('div', { style: { marginTop: 10 } },
                '探测结果：', h('code', null, str(p.reason) || '未知原因')),
              h('div', { className: 'fde-tip', style: { marginTop: 10 } },
                '重启方式：退出并重新打开 DSH（宿主半路由与技能注册在启动时加载），随后刷新此页面。')),
            h('div', { className: 'fde-compat-actions' },
              h(Btn, { kind: 'primary', onClick: p.onRetry }, t('compatRetry'))))));
    }

    function ProbingScreen() {
      return h('div', { className: 'fde-root' },
        h('div', { className: 'fde-top' },
          h('div', { className: 'fde-top-left' },
            h('div', { className: 'fde-title' }, t('fdeBrand')),
            h('div', { className: 'fde-subtitle' }, t('fdeTagline')))),
        h('div', { className: 'fde-compat' },
          h('div', { className: 'fde-compat-card' },
            h(Loading, { text: t('probing') }))));
    }

    function PanelApp(props) {
      const actions = (props && props.actions) || {};
      const [mode, setMode] = useState('probing');
      const [metaRaw, setMetaRaw] = useState(null);
      const [reason, setReason] = useState('');
      const seqRef = useRef(0);

      const probe = useCallback(async () => {
        seqRef.current += 1;
        const seq = seqRef.current;
        setMode('probing');
        const r = await getJSON(FDE + '/meta');
        if (seq !== seqRef.current) return;
        if (r && r.ok !== false && r.meta) {
          setMetaRaw(r.meta);
          setReason('');
          setMode('fde');
        } else {
          setReason((r && r.reason) || '宿主未提供 FDE 路由（HTTP 404）');
          setMode('compat');
        }
      }, []);

      useEffect(() => { probe(); }, [probe]);

      if (mode === 'fde') {
        return h(FdeApp, {
          actions,
          meta: normalizeMeta(metaRaw),
          onReprobe: probe,
        });
      }
      if (mode === 'probing') return h(ProbingScreen, null);
      return h(CompatPage, { reason, onRetry: probe });
    }

    const Icon = function () {
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
        h('path', { d: 'M4 4.5h6v6H4z' }),
        h('path', { d: 'M14 4.5h6v6h-6z' }),
        h('path', { d: 'M4 13.5h6v6H4z' }),
        h('path', { d: 'M14 13.5h6v6h-6z' }));
    };

    return {
      /* 必须声明依赖：否则 apply 早于 slots 服务就绪，ctx.slots 为 undefined，
         面板注册会被 catch 静默吞掉（已实测踩到）。 */
      inject: ['slots', 'uiWorkspace'],
      apply(ctx) {
        const svc = (n) => {
          try { const v = ctx[n]; if (v !== undefined && v !== null) return v; } catch (e) { /* ignore */ }
          try { return ctx.get ? ctx.get(n) : undefined; } catch (e) { return undefined; }
        };
        const slots = svc('slots');
        const uiWorkspace = svc('uiWorkspace');
        /* v1.7 资料预览：宿主已有 Remote 能力（只读；服务缺失时降级，不影响其它视图） */
        const sessionsService = svc('sessions');
        const officeToPdfRemote = svc('remote.officeToPdf');
        /* 宿主 uiWorkspace.openSession 的契约是 void（可能返回 undefined）：
           不能把返回值当成功标志；调用未抛错即视为已提交打开请求（§2.5）。 */
        const openSession = (id) => {
          if (!id) return false;
          try {
            if (uiWorkspace && typeof uiWorkspace.openSession === 'function') {
              uiWorkspace.openSession(id);
              return true;
            }
          } catch (e) { /* ignore */ }
          return false;
        };
        /* 在 Finder 中定位 / 打开。三条通道，逐条降级：
           ① DSH 客户端 Remote：session.openWorkspacePath（与「Open In…」按钮同一条链路，刷新页面即生效）
           ② open-in-app 路由：宿主已具备，目录可用
           ③ 本插件宿主路由 /research-workbench/api/reveal（兜底） */
        const remoteSession = () => {
          const direct = svc('remote.session');
          if (direct && typeof direct.openWorkspacePath === 'function') return direct;
          const remote = svc('remote');
          const nested = remote && remote.session;
          return nested && typeof nested.openWorkspacePath === 'function' ? nested : undefined;
        };
        const errTextOf = (e) => String((e && (e.message || e.code)) || e || '未知原因');
        const fileManagerApp = (() => {
          let plat = '';
          try { plat = String((typeof navigator !== 'undefined' && navigator.platform) || ''); } catch (e) { /* ignore */ }
          if (/win/i.test(plat)) return 'explorer';
          if (/linux/i.test(plat)) return 'filemanager';
          return 'finder';
        })();
        const openPath = async (absPath, mode, kind) => {
          const fails = [];
          const rs = remoteSession();
          if (rs) {
            try {
              const r = await rs.openWorkspacePath(mode === 'reveal' ? { path: absPath, action: 'reveal' } : { path: absPath });
              if (!r || r.ok !== false) return { ok: true, how: 'session-remote' };
              fails.push('remote：' + errTextOf(r.error));
            } catch (e) { fails.push('remote：' + errTextOf(e)); }
          } else fails.push('remote：session.openWorkspacePath 不可用');
          if (kind === 'dir') {
            try {
              const r = await postJSON('/open-in-app/open', { app: fileManagerApp, path: absPath });
              if (r && r.ok) return { ok: true, how: 'open-in-app' };
              fails.push('open-in-app：' + ((r && (r.message || r.reason)) || '失败'));
            } catch (e) { fails.push('open-in-app：' + errTextOf(e)); }
          }
          try {
            const r = await postJSON(API + '/reveal', { path: absPath, mode });
            if (r && r.ok) return { ok: true, how: r.how || 'host' };
            fails.push('host：' + ((r && (r.reason || r.message)) || '失败'));
          } catch (e) { fails.push('host：' + errTextOf(e)); }
          return { ok: false, reason: fails.join('；') };
        };
        if (!slots || typeof slots.inject !== 'function') {
          try { console.error('[research-workbench] slots 服务不可用，面板未注册'); } catch (e) { /* ignore */ }
        }
        let styleEl = null;
        try {
          styleEl = document.createElement('style');
          styleEl.setAttribute('data-plugin', 'research-workbench');
          styleEl.textContent = CSS;
          document.head.appendChild(styleEl);
        } catch (e) { /* ignore */ }
        const disposeStyle = () => {
          try { if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl); } catch (e) { /* ignore */ }
        };

        try {
          if (slots && typeof slots.inject === 'function') {
            slots.inject('sidebar.panellist', function () {
              return slots.register({ name: 'sidebar.panellist', id: 'researchworkbench', order: 32, label: function () { return t('fdeBrand'); } }, Icon);
            });
            slots.inject('main', function () {
              return slots.register({ name: 'main', key: 'researchworkbench' }, function () { return h(PanelApp, { actions: { openSession, openPath, services: { sessions: sessionsService, officeToPdf: officeToPdfRemote } } }); });
            });
          }
        } catch (e) {
          try { console.error('[research-workbench] 面板注册失败', e); } catch (e2) { /* ignore */ }
        }
        try { if (ctx.effect) ctx.effect(function () { return disposeStyle; }, 'research-workbench: styles'); } catch (e) { /* ignore */ }
      },
    };
  },
});
