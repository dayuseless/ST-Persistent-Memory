/**
 * ST-Persistent-Memory - 屏幕快捷悬浮按钮与拖拽持久化 (Floating Bubble & Draggable Service)
 * 职责：
 * 1. 注入屏幕快捷入口（悬浮气泡，支持任意拖拽与坐标记忆）
 * 2. 手机触控与桌面鼠标双端适配、防遮挡安全边缘算法
 * 3. 手机端与桌面端屏幕坐标隔离持久化存储 (localStorage)
 * 4. 坐标重置自愈服务 (resetBubblePosition)
 *
 * @version 0.1.44
 */

import { getSettings } from '../state.js';

/**
 * 注入屏幕快捷入口（悬浮气泡，支持任意拖拽与坐标记忆）
 */
export function createFloatingButton(onToggle) {
    if (typeof document === 'undefined') return;

    let btn = document.getElementById('pm-floating-bubble');
    if (btn) {
        // 保证悬浮球在宿主 DOM 异步重建后始终处于 document.body 内
        if (!document.body.contains(btn)) {
            document.body.appendChild(btn);
        }
        const shouldShow = getSettings().showFloatingBubble !== false;
        btn.style.setProperty('display', shouldShow ? 'flex' : 'none', 'important');
        return;
    }

    const isMobileDevice = typeof window !== 'undefined' && window.innerWidth <= 768;
    btn = document.createElement('div');
    btn.id = 'pm-floating-bubble';
    btn.className = 'pm-floating-bubble';
    btn.title = '持续记忆系统 (可拖拽，点击打开 HUD 面板)';
    btn.innerHTML = '<i class="fa-solid fa-brain"></i>';

    // 核心内联高可用防御样式：确保无论外部 CSS 载入延迟或样式冲突，悬浮球在双端均清晰可见且层级最高
    btn.style.position = 'fixed';
    btn.style.zIndex = '2147483647';
    btn.style.width = isMobileDevice ? '48px' : '46px';
    btn.style.height = isMobileDevice ? '48px' : '46px';
    btn.style.borderRadius = '50%';
    btn.style.alignItems = 'center';
    btn.style.justifyContent = 'center';
    btn.style.fontSize = isMobileDevice ? '20px' : '19px';
    btn.style.cursor = 'pointer';
    btn.style.userSelect = 'none';
    btn.style.webkitUserSelect = 'none';
    btn.style.touchAction = 'none';
    btn.style.boxSizing = 'border-box';
    btn.style.pointerEvents = 'auto';
    btn.style.visibility = 'visible';
    btn.style.opacity = '1';
    btn.style.background = '#ffffff';
    btn.style.color = '#2563eb';
    btn.style.border = '2px solid #2563eb';
    btn.style.boxShadow = '0 4px 16px rgba(0, 0, 0, 0.22), 0 1px 3px rgba(0, 0, 0, 0.12)';

    // 关键定位：从创建第 0 毫秒起即赋予明确的底右安全坐标，绝不依赖外部 CSS 下载完成，绝不出现在 (0, 0) 左上角！
    btn.style.setProperty('left', 'auto', 'important');
    btn.style.setProperty('top', 'auto', 'important');
    btn.style.setProperty('right', isMobileDevice ? '16px' : '20px', 'important');
    btn.style.setProperty('bottom', isMobileDevice ? '120px' : '85px', 'important');

    const shouldShow = getSettings().showFloatingBubble !== false;
    btn.style.setProperty('display', shouldShow ? 'flex' : 'none', 'important');
    if (!shouldShow) {
        console.log('[st_persistent_memory] 悬浮球配置为隐藏状态 (showFloatingBubble: false，可在顶部扩展菜单打开面板重新开启)');
    }

    // 绑定拖拽与响应式坐标记忆逻辑
    makeDraggable(btn, () => {
        if (typeof onToggle === 'function') {
            onToggle();
        }
    });

    document.body.appendChild(btn);
}

/**
 * 重置悬浮球位置到系统默认推荐坐标 (适配 PC 与 手机)
 */
export function resetBubblePosition() {
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.removeItem('pm_bubble_pos');
            localStorage.removeItem('pm_bubble_pos_mobile');
        }
    } catch {}
    if (typeof document !== 'undefined') {
        const bubble = document.getElementById('pm-floating-bubble');
        if (bubble) {
            const isMobileDevice = typeof window !== 'undefined' && window.innerWidth <= 768;
            bubble.style.setProperty('left', 'auto', 'important');
            bubble.style.setProperty('top', 'auto', 'important');
            bubble.style.setProperty('right', isMobileDevice ? '16px' : '20px', 'important');
            bubble.style.setProperty('bottom', isMobileDevice ? '120px' : '85px', 'important');
            bubble.style.setProperty('display', 'flex', 'important');
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
    if (typeof document === 'undefined') {
        return;
    }

    const bubble = document.getElementById('pm-floating-bubble');
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
            const badgeEl = document.createElement('div');
            badgeEl.className = 'pm-bubble-badge';
            badgeEl.textContent = String(info.badge);
            bubble.appendChild(badgeEl);
        }
        bubbleStateTimeout = setTimeout(() => {
            setBubbleState('idle');
        }, info.duration || 2600);
    } else if (state === 'error') {
        bubble.classList.add('pm-bubble-error');
        bubble.title = info.title || '持续记忆系统 (提炼遇到异常，点击查看)';
        bubble.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i>';
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
 * 拖拽核心算法：手机触控与桌面鼠标双端适配、防遮挡安全边缘、坐标隔离持久化
 */
export function makeDraggable(el, onClickCallback) {
    if (!el || typeof window === 'undefined') return;

    let isDragging = false;
    let hasMoved = false;
    let startX = 0, startY = 0;
    let initialX = 0, initialY = 0;
    let touchStartTime = 0;
    let lastTriggerTime = 0;

    const isMobile = () => window.innerWidth <= 768;
    const getStorageKey = () => isMobile() ? 'pm_bubble_pos_mobile' : 'pm_bubble_pos';

    // 恢复历史记忆位置 (手机端与桌面端分别记忆，避免桌面大屏坐标导致手机端飞出屏幕)
    const applyPosition = () => {
        let restored = false;
        try {
            const key = getStorageKey();
            const saved = localStorage.getItem(key);
            if (saved) {
                const { x, y } = JSON.parse(saved);
                if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) {
                    // 防御修复：过滤旧版本因无样式瞬态落入左上角死区 (x<=25 && y<=60) 的脏坐标，直接废弃并自愈回到底右安全位
                    if (x > 25 || y > 60) {
                        const maxX = Math.max(10, window.innerWidth - (el.offsetWidth || 48) - 10);
                        const maxY = Math.max(10, window.innerHeight - (el.offsetHeight || 48) - 10);
                        const clampedX = Math.min(Math.max(10, x), maxX);
                        const clampedY = Math.min(Math.max(10, y), maxY);
                        el.style.left = `${clampedX}px`;
                        el.style.top = `${clampedY}px`;
                        el.style.setProperty('right', 'auto', 'important');
                        el.style.setProperty('bottom', 'auto', 'important');
                        restored = true;
                    }
                }
            }
        } catch {}

        if (!restored) {
            // 未保存自定义位置或历史坐标异常时，赋予安全保底坐标 (手机端避开右下输入框与发送按钮)
            el.style.setProperty('left', 'auto', 'important');
            el.style.setProperty('top', 'auto', 'important');
            el.style.setProperty('right', isMobile() ? '16px' : '20px', 'important');
            el.style.setProperty('bottom', isMobile() ? '120px' : '85px', 'important');
        }
    };

    applyPosition();

    // 屏幕尺寸或横竖屏改变时，自动重新校准边缘安全范围
    const handleResize = () => {
        if (el.style.left && el.style.left !== 'auto') {
            const currentX = parseFloat(el.style.left);
            const currentY = parseFloat(el.style.top);
            if (Number.isFinite(currentX) && Number.isFinite(currentY)) {
                const maxX = Math.max(10, window.innerWidth - (el.offsetWidth || 48) - 10);
                const maxY = Math.max(10, window.innerHeight - (el.offsetHeight || 48) - 10);
                el.style.left = `${Math.min(Math.max(10, currentX), maxX)}px`;
                el.style.top = `${Math.min(Math.max(10, currentY), maxY)}px`;
            }
        }
    };
    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);

    const onStart = (e) => {
        isDragging = true;
        hasMoved = false;
        touchStartTime = Date.now();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        startX = clientX;
        startY = clientY;

        const rect = el.getBoundingClientRect();
        initialX = rect.left;
        initialY = rect.top;

        el.style.transition = 'none';
        el.classList.add('pm-dragging');

        window.addEventListener('mousemove', onMove, { passive: false });
        window.addEventListener('mouseup', onEnd);
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('touchend', onEnd);
        window.addEventListener('touchcancel', onEnd);
    };

    const onMove = (e) => {
        if (!isDragging) return;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const dx = clientX - startX;
        const dy = clientY - startY;

        // 触控防抖门限提升至 10px，避免高精度移动端触屏微小抖动误触发拖拽判定
        if (Math.hypot(dx, dy) > 10) {
            hasMoved = true;
            if (e.cancelable) e.preventDefault();
        }

        if (!hasMoved) return;

        let newX = initialX + dx;
        let newY = initialY + dy;

        const maxX = Math.max(0, window.innerWidth - (el.offsetWidth || 48));
        const maxY = Math.max(0, window.innerHeight - (el.offsetHeight || 48));
        newX = Math.min(Math.max(0, newX), maxX);
        newY = Math.min(Math.max(0, newY), maxY);

        el.style.left = `${newX}px`;
        el.style.top = `${newY}px`;
        el.style.setProperty('right', 'auto', 'important');
        el.style.setProperty('bottom', 'auto', 'important');
    };

    const onEnd = () => {
        if (!isDragging) return;
        isDragging = false;
        el.style.transition = '';
        el.classList.remove('pm-dragging');

        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onEnd);
        window.removeEventListener('touchmove', onMove);
        window.removeEventListener('touchend', onEnd);
        window.removeEventListener('touchcancel', onEnd);

        if (hasMoved) {
            const rect = el.getBoundingClientRect();
            try {
                localStorage.setItem(getStorageKey(), JSON.stringify({ x: rect.left, y: rect.top }));
            } catch {}
        } else {
            // 触屏轻触 Tap 兜底：快速点击直接响应
            const duration = Date.now() - touchStartTime;
            if (duration < 450) {
                const now = Date.now();
                if (now - lastTriggerTime > 300) {
                    lastTriggerTime = now;
                    onClickCallback?.();
                }
            }
        }
    };

    el.addEventListener('mousedown', onStart);
    el.addEventListener('touchstart', onStart, { passive: true });

    el.addEventListener('click', (e) => {
        if (hasMoved) {
            e.stopImmediatePropagation();
            e.preventDefault();
            hasMoved = false;
            return;
        }
        const now = Date.now();
        if (now - lastTriggerTime > 300) {
            lastTriggerTime = now;
            onClickCallback?.();
        }
    });
}
