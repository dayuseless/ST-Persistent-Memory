/**
 * ST-Persistent-Memory (v0.1.49) - 屏幕快捷悬浮按钮与拖拽持久化 (Floating Bubble & Draggable Service)
 * 职责：
 * 1. 注入屏幕快捷入口（悬浮气泡，支持任意拖拽与坐标记忆）
 * 2. 手机触控与桌面鼠标双端适配、防遮挡安全边缘算法
 * 3. 手机端与桌面端屏幕坐标隔离持久化存储 (localStorage)
 * 4. 坐标重置自愈服务 (resetBubblePosition)
 * 5. 跨 iframe/WebView 顶层窗口智能穿透 (resolveHostWindow) 与独立防裁切 Layer Host (ensureLayerHost)
 * 6. GPU 硬件加速 translate3d 渲染与 Unified Pointer Events 手势捕获引擎
 */

import { getSettings } from '../state.js';

/**
 * 寻找承载 SillyTavern 的顶级同源宿主窗口 (解决移动端 iframe/WebView 嵌套下无法穿透至主屏幕的痛点)
 */
export function resolveHostWindow() {
    if (typeof window === 'undefined') return null;
    let host = null;
    let cursor = window;
    for (let depth = 0; depth < 10; depth += 1) {
        if (!cursor) break;
        let usable = false;
        try {
            const doc = cursor.document || (cursor === window && typeof document !== 'undefined' ? document : null);
            usable = !!(doc && (cursor.SillyTavern || doc.getElementById?.('sheld') || doc.body));
        } catch {
            break;
        }
        if (usable) host = cursor;
        if (!cursor.parent || cursor === cursor.parent) break;
        cursor = cursor.parent;
    }
    if (host) {
        if (!host.document && typeof document !== 'undefined') host.document = document;
        return host;
    }
    try {
        if (window.top && (window.top.document || typeof document !== 'undefined')) {
            if (!window.top.document && typeof document !== 'undefined') window.top.document = document;
            return window.top;
        }
    } catch {}
    if (!window.document && typeof document !== 'undefined') window.document = document;
    return window;
}

/**
 * 确保屏幕顶层防裁切图层宿主 (pm-floating-layer) 存在
 * 借鉴 CatGod Oracle 工业级真机防护规范：
 * 强制重置 transform, perspective, filter, contain 为 none !important，彻底免疫 html/body 各种 3D 景深与负边距裁切
 */
export function ensureLayerHost() {
    const W = resolveHostWindow() || (typeof window !== 'undefined' ? window : null);
    const D = W?.document || (typeof document !== 'undefined' ? document : null);
    if (!W || !D) return null;

    let host = D.getElementById('pm-floating-layer');
    if (!host) {
        host = D.createElement('pm-floating-layer');
        host.id = 'pm-floating-layer';
        host.setAttribute('data-swipe-ignore', 'true');
        host.style.cssText = [
            'position:fixed', 'top:0', 'left:0', 'right:0', 'bottom:0', 'width:auto', 'height:auto',
            'min-width:0', 'min-height:0', 'max-width:none', 'max-height:none', 'margin:0', 'padding:0', 'border:0',
            'transform:none', 'translate:none', 'scale:none', 'rotate:none', 'perspective:none',
            'filter:none', 'backdrop-filter:none', '-webkit-backdrop-filter:none', 'contain:none',
            'container-type:normal', 'content-visibility:visible', 'will-change:auto',
            'display:block', 'overflow:visible', 'opacity:1', 'visibility:visible', 'z-index:2147483647', 'pointer-events:none'
        ].map(rule => `${rule}!important`).join(';');
    }
    if (!host.isConnected && D.body) {
        D.body.appendChild(host);
    }
    return { W, D, host };
}

/**
 * 测算真实可见视口尺寸 (多级取小避坑：解决移动端 WebView innerHeight 虚报或地址栏挤占问题)
 */
export function viewportBox(W, D, host) {
    const rect = host && host.isConnected && typeof host.getBoundingClientRect === 'function' ? host.getBoundingClientRect() : null;
    const root = D ? D.documentElement : null;
    const pick = (measured, client, fallback) => {
        // 过滤掉尚未完成布局渲染的异常极小值 (如尚未 layout 时误测出的 0 或小于 100 的非视口尺寸)
        const candidates = [];
        if (typeof measured === 'number' && measured >= 100) candidates.push(measured);
        if (typeof client === 'number' && client >= 100) candidates.push(client);
        if (typeof fallback === 'number' && fallback >= 100) candidates.push(fallback);
        if (candidates.length) return Math.min(...candidates);
        const values = [measured, client].filter(v => typeof v === 'number' && v > 0);
        return values.length ? Math.min(...values) : fallback;
    };
    return {
        width: pick(rect && rect.width, root ? root.clientWidth : 0, (W && W.innerWidth) || 1024),
        height: pick(rect && rect.height, root ? root.clientHeight : 0, (W && W.innerHeight) || 768),
    };
}

let ballPos = { x: 0, y: 0 };

/**
 * 将坐标通过 GPU 硬件加速 translate3d 渲染在屏幕上
 */
export function setBallPos(btn, x, y) {
    if (!btn || !btn.style) return;
    ballPos = { x, y };
    btn.style.left = '0px';
    btn.style.top = '0px';
    btn.style.right = 'auto';
    btn.style.bottom = 'auto';
    btn.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
}

export function getBallPos() {
    return { ...ballPos };
}

/**
 * 计算并定位悬浮球到目标安全坐标
 */
export function placeBall(btn, W, D, host) {
    const isMobile = ((W && W.innerWidth) || 1024) <= 768;
    const box = viewportBox(W, D, host);
    const size = (btn && btn.offsetWidth) || (isMobile ? 48 : 46);
    let x = 0, y = 0;
    let side = 'right';
    let restored = false;
    let needsPersistenceHealing = false;
    const storageKey = isMobile ? 'pm_bubble_pos_mobile' : 'pm_bubble_pos';
    const storage = W?.localStorage || (typeof localStorage !== 'undefined' ? localStorage : null);

    try {
        const saved = storage?.getItem(storageKey);
        if (saved) {
            const parsed = JSON.parse(saved);
            if (typeof parsed.x === 'number' && typeof parsed.y === 'number' && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
                // 过滤左上角死区脏数据 (x<=25 && y<=60)
                if (parsed.x > 25 || parsed.y > 60) {
                    const maxX = Math.max(10, box.width - size - 10);
                    const maxY = Math.max(10, box.height - size - 10);
                    x = Math.min(Math.max(10, parsed.x), maxX);
                    y = Math.min(Math.max(10, parsed.y), maxY);
                    side = parsed.side || (x + size / 2 < box.width / 2 ? 'left' : 'right');
                    restored = true;
                    // 若坐标超出当前屏幕被截断纠偏，标记需要持久化写回
                    if (x !== parsed.x || y !== parsed.y || side !== parsed.side) {
                        needsPersistenceHealing = true;
                    }
                } else {
                    needsPersistenceHealing = true;
                }
            } else {
                needsPersistenceHealing = true;
            }
        }
    } catch {
        needsPersistenceHealing = true;
    }

    if (!restored) {
        side = 'right';
        x = Math.max(10, box.width - size - (isMobile ? 16 : 20));
        y = Math.max(10, box.height - size - (isMobile ? 120 : 85));
    }

    // 持久化自愈：若发生脏坐标拦截或边界纠偏，将合法安全坐标同步写回缓存，杜绝下次启动重复纠偏
    if (needsPersistenceHealing && storage) {
        try {
            storage.setItem(storageKey, JSON.stringify({ x, y, side }));
        } catch {}
    }

    if (btn) {
        btn.setAttribute('data-side', side);
    }

    setBallPos(btn, x, y);
    return { x, y, side };
}

let restTimer = null;

/**
 * 唤醒悬浮球（拉出侧边，恢复全亮与完全可见状态）
 */
export function wakeBubble(btn) {
    if (!btn) return;
    if (restTimer) {
        clearTimeout(restTimer);
        restTimer = null;
    }
    btn.classList.remove('pm-resting');
    btn.classList.add('pm-wake');
}

/**
 * 调度悬浮球进入侧边半隐藏静止状态 (Resting Mode)
 */
export function scheduleBubbleRest(btn, delay = 3200) {
    if (!btn) return;
    if (restTimer) {
        clearTimeout(restTimer);
        restTimer = null;
    }
    if (getSettings().bubbleAutoDock === false) {
        btn.classList.remove('pm-resting');
        return;
    }

    const W = resolveHostWindow() || (typeof window !== 'undefined' ? window : null);
    const D = W?.document || (typeof document !== 'undefined' ? document : null);

    restTimer = setTimeout(() => {
        if (!btn || !btn.isConnected) return;
        const panel = D?.getElementById('pm-drawer-panel');
        const isPanelOpen = panel?.classList?.contains('pm-show');
        const isDragging = btn.classList?.contains('pm-dragging');
        const isHovered = typeof btn.matches === 'function' ? btn.matches(':hover') : false;

        if (!isPanelOpen && !isDragging && !isHovered) {
            btn.classList.remove('pm-wake');
            btn.classList.add('pm-resting');
        }
    }, delay);
}

/**
 * 注入屏幕快捷入口（悬浮气泡，支持任意拖拽与坐标记忆）
 */
export function createFloatingButton(onToggle) {
    const layer = ensureLayerHost();
    if (!layer || !layer.D) return;
    const { W, D, host } = layer;

    let btn = D.getElementById('pm-floating-bubble');
    if (btn) {
        if (!host.contains(btn)) {
            host.appendChild(btn);
        }
        const shouldShow = getSettings().showFloatingBubble !== false;
        btn.style.setProperty('display', shouldShow ? 'flex' : 'none', 'important');
        return;
    }

    const isMobileDevice = ((W && W.innerWidth) || 1024) <= 768;
    btn = D.createElement('div');
    btn.id = 'pm-floating-bubble';
    btn.className = 'pm-floating-bubble';
    btn.title = '持续记忆系统 (可拖拽，点击打开 HUD 面板)';
    btn.innerHTML = '<i class="fa-solid fa-brain"></i>';
    btn.setAttribute('data-swipe-ignore', 'true');
    btn.setAttribute('data-side', 'right');

    // 核心内联高可用防御样式：确保无论外部 CSS 载入延迟或样式冲突，悬浮球在双端均清晰可见且层级最高
    btn.style.position = 'fixed';
    btn.style.zIndex = '2147483647';
    btn.style.width = isMobileDevice ? '48px' : '46px';
    btn.style.height = isMobileDevice ? '48px' : '46px';
    btn.style.borderRadius = '50%';
    btn.style.alignItems = 'center';
    btn.style.justifyContent = 'center';
    btn.style.fontSize = isMobileDevice ? '20px' : '19px';
    btn.style.cursor = 'grab';
    btn.style.userSelect = 'none';
    btn.style.webkitUserSelect = 'none';
    btn.style.webkitTouchCallout = 'none';
    btn.style.touchAction = 'none';
    btn.style.boxSizing = 'border-box';
    btn.style.pointerEvents = 'auto';
    btn.style.visibility = 'visible';
    btn.style.opacity = '1';
    btn.style.background = '#ffffff';
    btn.style.color = '#2563eb';
    btn.style.border = '2px solid #2563eb';
    btn.style.boxShadow = '0 4px 16px rgba(0, 0, 0, 0.22), 0 1px 3px rgba(0, 0, 0, 0.12)';
    btn.style.willChange = 'transform, translate, opacity';

    const shouldShow = getSettings().showFloatingBubble !== false;
    btn.style.setProperty('display', shouldShow ? 'flex' : 'none', 'important');
    if (!shouldShow) {
        console.log('[st_persistent_memory] 悬浮球配置为隐藏状态 (showFloatingBubble: false，可在顶部扩展菜单打开面板重新开启)');
    }

    host.appendChild(btn);

    // 绑定拖拽与响应式坐标记忆逻辑 (Pointer Events + translate3d)
    makeDraggable(btn, () => {
        if (typeof onToggle === 'function') {
            onToggle();
        }
    });

    // 挂载后闲置自动优雅缩入侧边栏半隐藏
    scheduleBubbleRest(btn, 3500);
}

/**
 * 重置悬浮球位置到系统默认推荐坐标 (适配 PC 与 手机)
 */
export function resetBubblePosition() {
    const W = resolveHostWindow() || (typeof window !== 'undefined' ? window : null);
    try {
        const storage = W?.localStorage || (typeof localStorage !== 'undefined' ? localStorage : null);
        if (storage) {
            storage.removeItem('pm_bubble_pos');
            storage.removeItem('pm_bubble_pos_mobile');
        }
    } catch {}
    if (!W) return;
    const D = W.document;
    if (D) {
        const bubble = D.getElementById('pm-floating-bubble');
        if (bubble) {
            const layer = ensureLayerHost();
            placeBall(bubble, W, D, layer ? layer.host : null);
            wakeBubble(bubble);
            bubble.style.setProperty('display', 'flex', 'important');
            scheduleBubbleRest(bubble, 3500);
        }
    }
}

let currentBubbleState = 'idle';
let bubbleStateTimeout = null;

/**
 * 设置悬浮球的实时运行反馈状态 (提供有呼吸感的视觉交互)
 * @param {'idle' | 'digesting' | 'success' | 'error'} state
 * @param {object} [info={}]
 * @param {string} [info.title]
 * @param {string|number} [info.badge]
 * @param {number} [info.duration]
 */
export function setBubbleState(state, info = {}) {
    currentBubbleState = state;
    const W = resolveHostWindow() || (typeof window !== 'undefined' ? window : null);
    if (!W || !W.document) return;
    const D = W.document;

    const bubble = D.getElementById('pm-floating-bubble');
    if (!bubble) return;

    if (bubbleStateTimeout) {
        clearTimeout(bubbleStateTimeout);
        bubbleStateTimeout = null;
    }

    bubble.classList.remove('pm-bubble-digesting', 'pm-bubble-success', 'pm-bubble-error');

    // 清理角标
    const oldBadge = bubble.querySelector('.pm-bubble-badge');
    if (oldBadge) oldBadge.remove();

    if (state === 'digesting') {
        bubble.classList.add('pm-bubble-digesting');
        bubble.title = info.title || '持续记忆系统 (正在后台提炼中...)';
        bubble.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles fa-spin"></i>';
    } else if (state === 'success') {
        bubble.classList.add('pm-bubble-success');
        bubble.title = info.title || '持续记忆系统 (记忆提炼成功并沉淀)';
        bubble.innerHTML = '<i class="fa-solid fa-circle-check"></i>';
        if (info.badge) {
            const badgeEl = D.createElement('div');
            badgeEl.className = 'pm-bubble-badge';
            badgeEl.textContent = String(info.badge);
            bubble.appendChild(badgeEl);
        }
        bubbleStateTimeout = setTimeout(() => {
            setBubbleState('idle');
        }, info.duration || 3000);
    } else if (state === 'error') {
        bubble.classList.add('pm-bubble-error');
        bubble.title = info.title || '持续记忆系统 (提炼发生异常，请检查网络或 API 配置)';
        bubble.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i>';
        bubbleStateTimeout = setTimeout(() => {
            setBubbleState('idle');
        }, info.duration || 4000);
    } else {
        bubble.title = '持续记忆系统 (可拖拽，点击打开 HUD 面板)';
        bubble.innerHTML = '<i class="fa-solid fa-brain"></i>';
    }
}

/**
 * 获取当前悬浮球视觉状态
 */
export function getBubbleState() {
    return currentBubbleState;
}

/**
 * 拖拽核心算法：基于 W3C Pointer Events、setPointerCapture 与 translate3d 的跨端手势引擎
 */
export function makeDraggable(el, onClickCallback) {
    const W = resolveHostWindow() || (typeof window !== 'undefined' ? window : null);
    if (!W || !el) return;
    const D = W.document;
    const isMobile = () => ((W && W.innerWidth) || 1024) <= 768;
    const getStorageKey = () => isMobile() ? 'pm_bubble_pos_mobile' : 'pm_bubble_pos';

    let drag = null;
    let suppressClickUntil = 0;

    const layer = ensureLayerHost();
    const host = layer ? layer.host : null;

    // 初次定位
    placeBall(el, W, D, host);

    // 禁用移动端长按系统菜单
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    const onPointerDown = (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        drag = {
            id: e.pointerId,
            sx: e.clientX,
            sy: e.clientY,
            x: ballPos.x,
            y: ballPos.y,
            moved: false
        };

        try {
            el.setPointerCapture?.(e.pointerId);
        } catch {}

        wakeBubble(el);
    };

    const onPointerMove = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const dx = e.clientX - drag.sx;
        const dy = e.clientY - drag.sy;

        if (!drag.moved) {
            // 防抖阈值：手指触控小于 6px 的微小位移视为轻触，不触发拖拽
            if (Math.hypot(dx, dy) < 6) return;
            drag.moved = true;
            el.classList.add('pm-dragging');
            el.classList.remove('pm-snapping');
        }

        const box = viewportBox(W, D, host);
        const size = el.offsetWidth || (isMobile() ? 48 : 46);
        const maxX = Math.max(4, box.width - size - 4);
        const maxY = Math.max(4, box.height - size - 4);

        const currentX = Math.min(Math.max(4, drag.x + dx), maxX);
        const currentY = Math.min(Math.max(4, drag.y + dy), maxY);
        setBallPos(el, currentX, currentY);

        const side = currentX + size / 2 < box.width / 2 ? 'left' : 'right';
        el.setAttribute('data-side', side);
    };

    const endDrag = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const moved = drag.moved;
        drag = null;
        el.classList.remove('pm-dragging');

        try {
            el.releasePointerCapture?.(e.pointerId);
        } catch {}

        // 若没有发生有效位移（属于纯轻触点击），不重写坐标与吸附，由 click 事件精准触发控制台
        if (!moved) {
            scheduleBubbleRest(el, 3000);
            return;
        }

        // 发生过拖拽：设置 400ms 屏蔽窗口，拦截拖拽释放时浏览器伴生的合成 click 事件
        suppressClickUntil = Date.now() + 400;

        const box = viewportBox(W, D, host);
        const size = el.offsetWidth || (isMobile() ? 48 : 46);
        let currentX = ballPos.x;
        let currentY = ballPos.y;

        const autoDock = getSettings().bubbleAutoDock !== false;
        let side = currentX + size / 2 < box.width / 2 ? 'left' : 'right';

        if (autoDock) {
            // 智能边缘平滑吸附
            const edgeMargin = isMobile() ? 6 : 8;
            const snapX = side === 'left' ? edgeMargin : Math.max(edgeMargin, box.width - size - edgeMargin);
            const maxY = Math.max(10, box.height - size - 10);
            currentY = Math.min(Math.max(10, currentY), maxY);
            currentX = snapX;

            el.setAttribute('data-side', side);
            el.classList.add('pm-snapping');
            setBallPos(el, currentX, currentY);

            setTimeout(() => {
                el.classList.remove('pm-snapping');
            }, 450);
        }

        try {
            const storage = W?.localStorage || (typeof localStorage !== 'undefined' ? localStorage : null);
            storage?.setItem(getStorageKey(), JSON.stringify({ x: currentX, y: currentY, side }));
        } catch {}

        scheduleBubbleRest(el, 3000);
    };

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);

    // 唯一原生点击响应入口：零延迟、100% 灵敏响应轻触 (彻底消灭 double-toggle 假死 Bug)
    el.addEventListener('click', (e) => {
        if (Date.now() < suppressClickUntil) {
            e?.stopImmediatePropagation?.();
            e?.preventDefault?.();
            return;
        }
        wakeBubble(el);
        onClickCallback?.();
    });

    el.addEventListener('pointerenter', () => wakeBubble(el));
    el.addEventListener('pointerleave', () => {
        if (!drag) scheduleBubbleRest(el, 2500);
    });

    // 视口动态伸缩响应 (屏幕翻转、软键盘弹出/收起自适应)
    const onResize = () => {
        placeBall(el, W, D, host);
    };

    if (typeof W.addEventListener === 'function') {
        W.addEventListener('resize', onResize);
        W.addEventListener('orientationchange', onResize);
        if (W.visualViewport && typeof W.visualViewport.addEventListener === 'function') {
            W.visualViewport.addEventListener('resize', onResize);
            W.visualViewport.addEventListener('scroll', onResize);
        }
    }
}
