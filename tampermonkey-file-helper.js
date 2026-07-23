// ==UserScript==
// @name         睿美云 - 一键补报过期客户
// @namespace    realmerit-baobei-helper
// @version      3.4
// @description  顶层运行，通过 contentDocument 直接操作 iframe 内 DOM，绕过 Tampermonkey iframe 注入限制
// @author       kounenn
// @match        https://system.realmerit.com.cn/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    console.log('%c[睿美云补报 v3.4] 脚本已加载（顶层模式 → 操作 iframe DOM）', 'color:#2f54eb;font-weight:bold;font-size:14px;');

    // ============================================================
    //  iframe 上下文管理 —— 核心抽象层
    //  所有 DOM 操作都通过 ctx.doc / ctx.win 访问 iframe 内部
    // ============================================================
    const ctx = { doc: null, win: null, iframe: null, ready: false };

    function refreshContext() {
        let iframe = document.getElementById('realmerit');
        if (!iframe) iframe = document.querySelector('iframe');
        if (!iframe) {
            ctx.ready = false;
            return false;
        }
        try {
            const doc = iframe.contentDocument || iframe.contentWindow.document;
            const win = iframe.contentWindow;
            if (doc && doc.body && doc.readyState !== 'loading') {
                ctx.iframe = iframe;
                ctx.doc = doc;
                ctx.win = win;
                ctx.ready = true;
                return true;
            }
        } catch (e) {
            // 跨域或未就绪
        }
        ctx.ready = false;
        return false;
    }

    // ============================================================
    //  选择器配置
    // ============================================================
    const SEL = {
        // === 表格行 ===
        tableRow:          'tr.ant-table-row',
        customerIdAttr:    'data-row-key',
        tableHeader:       '.ant-table-thead tr th:first-child',

        // === 行内元素 ===
        customerName:      'span.fw-b',
        customerPhone:     'span.csp.mainColor',
        btnReport:         'button.table_actionButton-primary',

        // === 抽屉（点击客户姓名打开）===
        drawer:            '.ant-drawer-content',
        drawerClose:       '.ant-drawer-close',
        // 抽屉内 tab：div.tab_item，激活时带 active class
        drawerTab:         '.ant-drawer-content .tab_item',
        drawerTabActive:   '.ant-drawer-content .tab_item.active',

        // === 报备记录表格 ===
        // 表格在"客户信息"tab内容里
        reportTable:       '.ant-drawer-content .ant-table',
        // 附件图标：i.iconfont.icon-fujian1（在表格第9列 td index=8）
        attachIcon:        'i.iconfont.icon-fujian1',

        // === 图片查看器（点击附件图标后弹出的 modal）===
        // modal 容器：.ant-modal-wrap.ngModal.ngslider
        viewerModal:       '.ant-modal-wrap.ngModal.ngslider',
        // 实际图片：img.viewer-move.viewer-transition
        viewerImage:       'img.viewer-move.viewer-transition',
        // 关闭按钮
        viewerClose:       '.viewer-close, .ant-modal-close, [data-viewer-action="hide"]',

        // === 报备弹窗 ===
        // 弹窗容器：.ant-modal-wrap.ngModal.ant-modal-centered
        reportModal:       '.ant-modal-wrap.ngModal',
        reportModalContent: '.ant-modal-content',
        reportModalClose:  '.ant-modal-close',
        // 手机号输入框：id="customerPhone"（固定 id）
        reportFormPhone:   'input#customerPhone',
        // 保存按钮：button.primary_btn（class 含 ant-btn-primary ant-btn-two-chinese-chars）
        // 注意：没有 .ant-modal-footer 包裹，按钮直接在 .ant-spin-container > .mt-14.pr-20 里
        reportFormSubmit:  'button.primary_btn',
        reportFormCancel:  'button.default_btn',
        // TreeSelect（报备项目）
        // 关键：有两个 multiple tree-select（报备项目 + 报备部门），不能用 .ant-select-multiple 定位
        // 在代码中通过遍历 form-item label 文字来精确定位
        reportFormDeptSelector: '.ant-select-selector',
        // 下拉树容器
        reportFormDeptDropdown: '.ant-select-dropdown.ant-tree-select-dropdown',
        // 树节点
        reportFormDeptNode: '.ant-select-tree-treenode',
        // checkbox 容器（点击这个来勾选）
        reportFormDeptCheckbox: '.ant-select-tree-checkbox',
        // checkbox 内部元素
        reportFormDeptCheckboxInner: '.ant-select-tree-checkbox-inner',
        // 节点标题（title 属性含文字）
        reportFormDeptTitle: '.ant-select-tree-title',
        // 上传按钮
        reportFormImageBtn: 'span.ng_upload_add.csp',
        fileInput:         'input[type="file"]',
    };

    const API = {
        bespeakList:     '/v2/bespeak/bespeakList',
        bespeakListInit: '/v2/bespeak/bespeakListInit',
        deptTree:        '/v1/dept/tree',
        qiniuUptoken:    '/v1/qiniu/uptoken',
        qiniuUptokenV2:  '/v1/qiniu/uptokenV2',
        securityToken:   '/v1/normal/getSecurityToken',
        awsTempUrl:      '/v1/aws/tempUploadUrl',
    };

    const DEFAULTS = {
        departments: ['皮肤科', '注射科'],
        remark: '',
        cacheExpiry: 24 * 60 * 60 * 1000,
        minImageSize: 10240,
        requestDelay: 1500,
        modalTimeout: 10000,
    };

    const state = {
        running: false,
        inspectorMode: false,
        batchResults: { success: 0, failed: 0, skipped: 0 },
        iframeReady: false,
    };

    // ============================================================
    //  工具函数
    // ============================================================
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    function log(msg, level = 'info') {
        const logEl = document.getElementById('rmh-log');
        const time = new Date().toLocaleTimeString();
        const colors = { info: '#555', success: '#52c41a', warn: '#faad14', error: '#ff4d4f' };
        const prefix = { info: '', success: '[OK] ', warn: '[!] ', error: '[ERR] ' };
        const line = `[${time}] ${prefix[level] || ''}${msg}`;
        console.log('[睿美云补报]', line);
        if (logEl) {
            const div = document.createElement('div');
            div.textContent = line;
            div.style.color = colors[level] || '#555';
            logEl.insertBefore(div, logEl.firstChild);
        }
    }

    function notify(title, text) {
        try { GM_notification({ title, text: text || '', timeout: 4000 }); } catch (e) {}
    }

    // 更新面板状态指示器
    function updateStatus(text, color) {
        const el = document.getElementById('rmh-status');
        if (el) {
            el.textContent = text;
            el.style.color = color || '#8c8c8c';
        }
    }

    // iframe DOM 查询快捷方法
    function $q(selector) {
        if (!ctx.doc) return null;
        return ctx.doc.querySelector(selector);
    }

    function $qa(selector) {
        if (!ctx.doc) return [];
        return Array.from(ctx.doc.querySelectorAll(selector));
    }

    // 等待 iframe 内元素出现（轮询式，抗导航）
    async function waitForElement(selector, timeout = DEFAULTS.modalTimeout) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            refreshContext();
            if (ctx.doc) {
                const el = ctx.doc.querySelector(selector);
                if (el) return el;
            }
            await sleep(300);
        }
        throw new Error(`等待元素超时: ${selector}`);
    }

    async function waitForModalClose(selector, timeout = DEFAULTS.modalTimeout) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            refreshContext();
            if (ctx.doc) {
                const el = ctx.doc.querySelector(selector);
                if (!el) return true;
                const modal = el.closest('.ant-modal');
                if (modal && getComputedStyle(modal).display === 'none') return true;
            }
            await sleep(300);
        }
        return false;
    }

    // ============================================================
    //  React / Ant Design DOM 操作助手
    //  关键：使用 iframe 窗口的原型和事件构造器
    // ============================================================
    function setReactInputValue(input, value) {
        if (!ctx.win) return;
        const nativeSetter = Object.getOwnPropertyDescriptor(
            ctx.win.HTMLInputElement.prototype, 'value'
        ).set;
        nativeSetter.call(input, value);
        input.dispatchEvent(new ctx.win.Event('input', { bubbles: true }));
        input.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
        // 用 focusout 替代 blur：focusout 会冒泡，系统能监听到；
        // 且不会真正转移焦点，避免焦点跳到客户来源 radio 上
        input.dispatchEvent(new ctx.win.FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    }

    function setReactTextareaValue(textarea, value) {
        if (!ctx.win) return;
        const nativeSetter = Object.getOwnPropertyDescriptor(
            ctx.win.HTMLTextAreaElement.prototype, 'value'
        ).set;
        nativeSetter.call(textarea, value);
        textarea.dispatchEvent(new ctx.win.Event('input', { bubbles: true }));
        textarea.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
    }

    // 检查报备弹窗必填字段是否已填充
    function checkRequiredFields() {
        const modal = $q(SEL.reportModal);
        if (!modal) return { allFilled: false, missing: ['未找到弹窗'] };

        const missing = [];
        const formItems = modal.querySelectorAll('.ant-form-item');
        for (const item of formItems) {
            const label = item.querySelector('.ant-form-item-label');
            if (!label) continue;
            const isRequired = label.querySelector('.ant-form-item-required') !== null;
            if (!isRequired) continue;
            const labelText = label.textContent.trim();

            if (labelText.includes('客户电话')) {
                const phone = item.querySelector('input#customerPhone');
                if (!phone || !phone.value) missing.push('客户电话');
            } else if (labelText.includes('客户来源')) {
                const checked = item.querySelector('.ant-radio-checked');
                if (!checked) missing.push('客户来源');
            } else if (labelText.includes('报备项目')) {
                const tags = item.querySelectorAll('.ant-select-selection-item');
                if (tags.length === 0) missing.push('报备项目');
            } else if (labelText.includes('目标报备人')) {
                const tags = item.querySelectorAll('.ant-select-selection-item');
                if (tags.length === 0) missing.push('目标报备人');
            } else if (labelText.includes('目标报备部门')) {
                const tags = item.querySelectorAll('.ant-select-selection-item');
                if (tags.length === 0) missing.push('目标报备部门');
            }
        }
        return { allFilled: missing.length === 0, missing };
    }

    // 手动选择客户来源（当自动填充失败时 fallback）
    function selectCustomerSource(sourceText) {
        if (!sourceText) return false;
        const modal = $q(SEL.reportModal);
        if (!modal) return false;

        const formItems = modal.querySelectorAll('.ant-form-item');
        for (const item of formItems) {
            const label = item.querySelector('.ant-form-item-label');
            if (!label || !label.textContent.includes('客户来源')) continue;

            const radios = item.querySelectorAll('.ant-radio-input');
            for (const radio of radios) {
                const wrapper = radio.closest('.ant-radio-wrapper');
                if (!wrapper) continue;
                const text = wrapper.textContent.trim();
                if (text === sourceText || text.includes(sourceText)) {
                    simulateClick(wrapper); // 点击整个 radio wrapper
                    log(`  [表单填写] 手动选择客户来源: ${text}`, 'success');
                    return true;
                }
            }
        }
        return false;
    }

    function simulateClick(el) {
        if (!ctx.win) return;
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const opts = { bubbles: true, cancelable: true, view: ctx.win, clientX: x, clientY: y };

        try { el.dispatchEvent(new ctx.win.PointerEvent('pointerdown', { ...opts, pointerId: 1 })); } catch(e) {}
        el.dispatchEvent(new ctx.win.MouseEvent('mousedown', opts));
        try { el.dispatchEvent(new ctx.win.PointerEvent('pointerup', { ...opts, pointerId: 1 })); } catch(e) {}
        el.dispatchEvent(new ctx.win.MouseEvent('mouseup', opts));
        el.dispatchEvent(new ctx.win.MouseEvent('click', opts));
    }

    function findElementByText(selector, text) {
        const els = $qa(selector);
        for (const el of els) {
            if (el.textContent.trim().includes(text)) return el;
        }
        return null;
    }

    function findButtonInModal(modalSelector, text) {
        const modal = $q(modalSelector);
        if (!modal) return null;
        const btns = modal.querySelectorAll('button, a, span[role="button"], .ant-btn');
        for (const btn of btns) {
            if (btn.textContent.trim().includes(text)) return btn;
        }
        return findElementByText('button, a, .ant-btn', text);
    }

    // === Ant Design TreeSelect 复选框选择 ===
    // 适用于带 checkable 的 TreeSelect（如报备项目选择）
    // 流程：打开下拉 → 按文字找节点 → 点击复选框
    // 通过 form-item label 文字精确定位 TreeSelect（避免匹配到"目标报备部门"）
    function findTreeSelectByLabel(labelText) {
        const formItems = $qa('.ant-form-item');
        for (const fi of formItems) {
            const label = fi.querySelector('.ant-form-item-label')?.textContent?.trim() || '';
            if (label === labelText) {
                const treeSelect = fi.querySelector('.ant-select.ant-tree-select');
                if (treeSelect) return treeSelect;
            }
        }
        return null;
    }

    // 选择报备项目中的多个科室（如"皮肤科"+"注射科"）
    // 一次性打开下拉、连续勾选多个选项、最后关闭，避免重复打开/关闭的时序问题
    async function selectDepartments(optionTexts) {
        log(`  [科室选择] 需要勾选: ${optionTexts.join(', ')}`);

        // 1. 通过 form-item label="报备项目" 精确定位 TreeSelect
        const treeSelect = findTreeSelectByLabel('报备项目');
        if (!treeSelect) {
            throw new Error('未找到"报备项目"TreeSelect（form-item label="报备项目"）');
        }

        // 2. 点击 .ant-select-selector 打开下拉
        const selector = treeSelect.querySelector(SEL.reportFormDeptSelector);
        if (!selector) {
            throw new Error('报备项目 TreeSelect 的 .ant-select-selector 未找到');
        }

        // 滚动到可见
        treeSelect.scrollIntoView({ block: 'center' });
        await sleep(200);

        // 打开下拉（如果没打开）
        const isOpen = treeSelect.classList.contains('ant-select-open');
        if (!isOpen) {
            log(`  [科室选择] 点击选择器打开下拉...`);
            simulateClick(selector);
            await sleep(800);
        }

        // 3. 等待下拉树出现
        let attempts = 0;
        let dropdown = null;
        let nodes = [];
        while (attempts < 20) {
            const allDropdowns = $qa(SEL.reportFormDeptDropdown);
            for (const dd of allDropdowns) {
                if (!dd.classList.contains('ant-select-dropdown-hidden') &&
                    dd.textContent.trim().length > 0) {
                    dropdown = dd;
                    break;
                }
            }
            if (dropdown) {
                nodes = dropdown.querySelectorAll(SEL.reportFormDeptNode);
                if (nodes.length > 0) break;
            }
            await sleep(200);
            attempts++;
        }

        if (nodes.length === 0) {
            throw new Error(`TreeSelect 下拉树未出现（尝试 ${attempts} 次）`);
        }

        log(`  [科室选择] 下拉树已打开，共 ${nodes.length} 个节点`);

        // 4. 逐个勾选目标科室（在同一个打开的下拉中操作）
        const successList = [];
        const failedList = [];

        for (const optionText of optionTexts) {
            let found = false;

            // 每次重新查找节点（因为勾选后 React 可能重渲染）
            const currentNodes = dropdown.querySelectorAll(SEL.reportFormDeptNode);

            for (const node of currentNodes) {
                const titleEl = node.querySelector(SEL.reportFormDeptTitle);
                const nodeText = titleEl?.getAttribute('title') ||
                                titleEl?.textContent?.trim() ||
                                node.textContent.trim();

                if (nodeText === optionText || nodeText.includes(optionText)) {
                    const checkbox = node.querySelector(SEL.reportFormDeptCheckbox);
                    if (!checkbox) {
                        log(`  [科室选择] 节点「${nodeText}」未找到 checkbox，跳过`, 'warn');
                        continue;
                    }

                    // 检查是否已选中
                    const isChecked = checkbox.classList.contains('ant-select-tree-checkbox-checked');

                    if (isChecked) {
                        log(`  [科室选择] 「${optionText}」已选中，跳过`);
                        found = true;
                        successList.push(optionText);
                        break;
                    }

                    // 点击 checkbox 勾选
                    log(`  [科室选择] 点击 checkbox 勾选「${nodeText}」...`);
                    simulateClick(checkbox);
                    await sleep(600);
                    log(`  [科室选择] 已勾选: ${optionText} ✓`, 'success');
                    found = true;
                    successList.push(optionText);
                    break;
                }
            }

            if (!found) {
                failedList.push(optionText);
                log(`  [科室选择] 未找到「${optionText}」节点`, 'warn');
            }
        }

        // 诊断：如果全部失败，输出所有节点文字
        if (failedList.length === optionTexts.length) {
            const allTexts = Array.from(dropdown.querySelectorAll(SEL.reportFormDeptNode)).map(n => {
                const t = n.querySelector(SEL.reportFormDeptTitle);
                return t?.getAttribute('title') || t?.textContent?.trim() || n.textContent.trim();
            }).filter(t => t);
            log(`  [科室选择] 所有节点: ${allTexts.join(', ')}`, 'warn');
        }

        log(`  [科室选择] 完成: 成功 ${successList.length}/${optionTexts.length}` +
            (failedList.length > 0 ? ` | 失败: ${failedList.join(', ')}` : ''),
            failedList.length > 0 ? 'warn' : 'success');

        return failedList.length === 0;
    }

    // 关闭 TreeSelect 下拉
    async function closeTreeSelectDropdown() {
        pressEscape();
        await sleep(300);
    }

    // 智能文件上传：优先在报备弹窗内找 input[type=file]，也支持通过上传按钮定位
    function triggerFileUpload(fileInputSelector, file) {
        if (!ctx.win) throw new Error('iframe 窗口不可用');

        let input = null;

        // 策略1：直接用选择器找
        input = $q(fileInputSelector);

        // 策略2：在报备弹窗内找
        if (!input) {
            const modal = $q(SEL.reportModal);
            if (modal) {
                input = modal.querySelector('input[type="file"]');
            }
        }

        // 策略3：在上传按钮附近找（包括 ng_upload 容器）
        if (!input) {
            const uploadBtn = $q(SEL.reportFormImageBtn);
            if (uploadBtn) {
                // 往上找容器，再往下找 input
                let container = uploadBtn.parentElement;
                for (let i = 0; i < 6 && container; i++) {
                    input = container.querySelector('input[type="file"]');
                    if (input) break;
                    // 同时搜索 ng_upload 内部
                    if (container.classList && container.classList.contains('ng_upload')) {
                        input = container.querySelector('input[type="file"]');
                        if (input) break;
                    }
                    container = container.parentElement;
                }
            }
        }

        // 策略4：在 ng_upload 组件中找（不依赖按钮）
        if (!input) {
            const ngUpload = $q('.ng_upload, .ng-upload');
            if (ngUpload) {
                input = ngUpload.querySelector('input[type="file"]');
            }
        }

        // 策略5：全局找最后一个 file input（兜底）
        if (!input) {
            const allInputs = $qa('input[type="file"]');
            if (allInputs.length > 0) {
                input = allInputs[allInputs.length - 1];
                log(`  [文件上传] 通过全局兜底找到 file input`, 'warn');
            }
        }

        if (!input) {
            throw new Error('未找到文件上传 input[type="file"]，请确认上传按钮已渲染');
        }

        const dt = new ctx.win.DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
        input.dispatchEvent(new ctx.win.Event('input', { bubbles: true }));
    }

    // ============================================================
    //  图片处理（GM_xmlhttpRequest 在顶层运行，无需改动）
    // ============================================================
    function downloadImage(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                responseType: 'blob',
                onload: (resp) => {
                    if (resp.status >= 200 && resp.status < 300) {
                        resolve(resp.response);
                    } else {
                        reject(new Error(`下载失败 HTTP ${resp.status}`));
                    }
                },
                onerror: (err) => reject(err),
                ontimeout: () => reject(new Error('下载超时')),
            });
        });
    }

    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    function base64ToFile(base64, filename) {
        const arr = base64.split(',');
        const mime = arr[0].match(/:(.*?);/)[1];
        const bstr = atob(arr[1]);
        const u8arr = new Uint8Array(bstr.length);
        for (let i = 0; i < bstr.length; i++) {
            u8arr[i] = bstr.charCodeAt(i);
        }
        // 用 iframe 窗口的 File 构造器，确保兼容性
        const FileConstructor = (ctx.win && ctx.win.File) || File;
        return new FileConstructor([u8arr], filename, { type: mime });
    }

    function blobToFile(blob, filename) {
        const FileConstructor = (ctx.win && ctx.win.File) || File;
        return new FileConstructor([blob], filename, { type: blob.type || 'image/jpeg' });
    }

    function setCachedImage(customerId, base64) {
        const key = `cached_report_image_${customerId}`;
        try {
            const data = { image: base64, timestamp: Date.now() };
            localStorage.setItem(key, JSON.stringify(data));
            log(`  图片已缓存: ${key}`);
        } catch (e) {
            log(`缓存失败（可能超出 localStorage 限制）: ${e.message}`, 'warn');
        }
    }

    function getCachedImage(customerId) {
        const key = `cached_report_image_${customerId}`;
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        try {
            const data = JSON.parse(raw);
            if (Date.now() - data.timestamp > DEFAULTS.cacheExpiry) {
                localStorage.removeItem(key);
                return null;
            }
            return data.image;
        } catch (e) {
            return null;
        }
    }

    async function compressImage(blob, maxWidth = 800, quality = 0.8) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const scale = Math.min(1, maxWidth / img.width);
                canvas.width = img.width * scale;
                canvas.height = img.height * scale;
                const c = canvas.getContext('2d');
                c.drawImage(img, 0, 0, canvas.width, canvas.height);
                canvas.toBlob(resolve, 'image/jpeg', quality);
            };
            img.onerror = () => resolve(blob);
            img.src = URL.createObjectURL(blob);
        });
    }

    function imageViaCanvas(imgEl) {
        return new Promise((resolve, reject) => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = imgEl.naturalWidth;
                canvas.height = imgEl.naturalHeight;
                const c = canvas.getContext('2d');
                c.drawImage(imgEl, 0, 0);
                canvas.toBlob(resolve, 'image/jpeg', 0.9);
            } catch (e) {
                reject(e);
            }
        });
    }

    // ============================================================
    //  关闭弹窗/抽屉/查看器（操作 iframe 内 DOM）
    // ============================================================
    function closeModal() {
        const closeBtn = $q(SEL.reportModalClose);
        if (closeBtn) {
            simulateClick(closeBtn);
            return;
        }
        pressEscape();
    }

    function closeDrawer() {
        const closeBtn = $q(SEL.drawerClose);
        if (closeBtn) {
            simulateClick(closeBtn);
            return;
        }
        pressEscape();
    }

    function closeViewer() {
        const closeBtn = $q(SEL.viewerClose);
        if (closeBtn) {
            simulateClick(closeBtn);
            return;
        }
        // viewer.js 通常支持 Escape 关闭
        pressEscape();
    }

    function pressEscape() {
        if (ctx.doc && ctx.win) {
            ctx.doc.dispatchEvent(new ctx.win.KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, code: 'Escape', bubbles: true }));
            ctx.doc.dispatchEvent(new ctx.win.KeyboardEvent('keyup', { key: 'Escape', keyCode: 27, code: 'Escape', bubbles: true }));
        }
    }

    // ============================================================
    //  辅助：切换抽屉内的 tab（如"客户信息"）
    //  DOM 结构：div.tab_item > div.tab_item_center（含文字）
    //  激活时 tab_item 带 active class
    // ============================================================
    async function switchDrawerTab(tabName) {
        const tabs = $qa(SEL.drawerTab);
        for (const tab of tabs) {
            const text = tab.textContent.trim();
            if (text.includes(tabName)) {
                // 检查是否已激活
                if (tab.classList.contains('active')) {
                    log(`  [截图抓取] "${tabName}" tab 已激活`);
                    return true;
                }
                log(`  [截图抓取] 切换到 "${tabName}" tab...`);
                simulateClick(tab);
                await sleep(1500); // 等 tab 内容渲染
                return true;
            }
        }
        // fallback：找所有含 tabName 文字的 div
        const allEls = $qa(`${SEL.drawer} div, ${SEL.drawer} span`);
        for (const el of allEls) {
            if (el.textContent.trim() === tabName) {
                simulateClick(el);
                await sleep(1500);
                return true;
            }
        }
        return false;
    }

    // ============================================================
    //  辅助：在报备记录表格中找到附件图标
    //  DOM 结构：.ant-table > tbody > tr > td(第9列 index=8) > i.iconfont.icon-fujian1
    //  有附件的行：td 内含 <i class="iconfont icon-fujian1 mainColor csp"></i>
    //  无附件的行：td 内只有空格
    // ============================================================
    function findAttachmentsInDrawer() {
        const drawer = $q(SEL.drawer);
        if (!drawer) return [];

        // 找报备记录表格
        const tables = $qa(SEL.reportTable);
        let targetTable = null;
        for (const table of tables) {
            // 确认是报备记录表格（表头含"附件"）
            const headerText = table.textContent;
            if (headerText.includes('附件') && headerText.includes('报备')) {
                targetTable = table;
                break;
            }
        }
        if (!targetTable) {
            // fallback：取抽屉内最后一个表格
            if (tables.length > 0) {
                targetTable = tables[tables.length - 1];
            }
        }
        if (!targetTable) {
            log(`  [截图抓取] 未找到报备记录表格`, 'warn');
            return [];
        }

        // 找表格行
        const rows = targetTable.querySelectorAll('tr.ant-table-row, tbody tr');
        const attachments = [];

        for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
            const row = rows[rowIdx];
            const cells = row.querySelectorAll('td');
            if (cells.length < 9) continue;

            // 附件列是第9列（index=8）
            const attachCell = cells[8];
            if (!attachCell) continue;

            // 找 i.icon-fujian1 图标
            const icon = attachCell.querySelector('i.iconfont.icon-fujian1, i.icon-fujian1');
            if (icon) {
                // 获取该行的报备信息
                const reportType = cells[1] ? cells[1].textContent.trim() : '';
                const reportTime = cells[7] ? cells[7].textContent.trim() : '';
                attachments.push({
                    icon: icon,
                    rowIdx: rowIdx,
                    reportType: reportType,
                    reportTime: reportTime
                });
                log(`  [截图抓取] 行 ${rowIdx + 1}: 找到附件图标（类型:${reportType} 时间:${reportTime}）`);
            }
        }

        if (attachments.length === 0) {
            log(`  [截图抓取] 报备记录表格中未找到附件图标（i.icon-fujian1）`, 'warn');
            log(`  [截图抓取] 该客户可能没有历史报备附件`, 'warn');
        }

        return attachments;
    }

    // ============================================================
    //  辅助：关闭所有已打开的图片查看器 modal
    // ============================================================
    function closeAllViewers() {
        // 关闭所有 ngModal ngslider 类型的 modal
        const modals = $qa(SEL.viewerModal);
        for (const modal of modals) {
            // 尝试点击关闭按钮
            const closeBtn = modal.querySelector('.ant-modal-close, .viewer-close, [data-viewer-action="hide"]');
            if (closeBtn) {
                simulateClick(closeBtn);
            }
        }
        // 也尝试 ESC
        pressEscape();
    }

    // ============================================================
    //  辅助：下载单个附件并检查文件大小
    //  流程：点击 i.icon-fujian1 → 等待 modal → 找 img.viewer-move → 
    //        过滤头像（src 含 static.web.realmerit.com.cn）→ 下载 → 检查大小
    //  返回 base64 或 null（太小/失败时返回 null）
    // ============================================================
    async function downloadAttachment(attachment, index, total, customerId) {
        const { icon, rowIdx, reportType, reportTime } = attachment;
        log(`  [截图抓取] 检查附件 ${index + 1}/${total}（行${rowIdx + 1} 类型:${reportType}）...`);

        // 先关闭所有已存在的查看器
        closeAllViewers();
        await sleep(500);

        // 点击附件图标
        simulateClick(icon);
        await sleep(2000); // 等 modal 动画完成

        // 等待图片查看器 modal 出现
        let modal;
        try {
            modal = await waitForElement(SEL.viewerModal, 5000);
        } catch (e) {
            log(`  [截图抓取] 附件 ${index + 1}: modal 未出现`, 'warn');
            pressEscape();
            await sleep(300);
            return null;
        }

        await sleep(500); // 等图片加载

        // 在 modal 中找图片
        // 可能有多张 img.viewer-move.viewer-transition（如果之前的 modal 没关干净）
        const viewerImgs = Array.from($qa(SEL.viewerImage));

        if (viewerImgs.length === 0) {
            log(`  [截图抓取] 附件 ${index + 1}: modal 中未找到 img.viewer-move`, 'warn');
            closeAllViewers();
            await sleep(300);
            return null;
        }

        // 过滤：排除头像图片（src 含 static.web.realmerit.com.cn/client-images）
        // 排除空 src 的图片
        // 排除 naturalWidth < 200 的（图标占位符）
        let targetImg = null;
        for (const img of viewerImgs) {
            const src = img.src || '';
            if (!src) continue;
            // 排除静态资源图片（头像、占位图等）
            if (src.includes('static.web.realmerit.com.cn/client-images')) continue;
            if (src.includes('default_icon') || src.includes('placeholder') || src.includes('cat.png')) continue;
            // 排除页面 URL 作为 src 的
            if (src.includes('app.html') || src.includes('system.realmerit.com.cn/static')) continue;
            // 找到真实附件图片
            targetImg = img;
            break;
        }

        // fallback：如果没找到，取 naturalWidth 最大的
        if (!targetImg) {
            targetImg = viewerImgs.reduce((max, img) => {
                const maxArea = (max?.naturalWidth || 0) * (max?.naturalHeight || 0);
                const imgArea = (img.naturalWidth || 0) * (img.naturalHeight || 0);
                return imgArea > maxArea ? img : max;
            }, null);
        }

        if (!targetImg) {
            log(`  [截图抓取] 附件 ${index + 1}: 未找到有效图片`, 'warn');
            closeAllViewers();
            await sleep(300);
            return null;
        }

        const targetUrl = targetImg.src;
        log(`  [截图抓取] 找到图片: ${targetUrl.substring(0, 80)}... (${targetImg.naturalWidth}×${targetImg.naturalHeight})`);

        // 下载图片
        let blob;
        try {
            blob = await downloadImage(targetUrl);
        } catch (e) {
            // 尝试通过 canvas 获取
            try {
                blob = await imageViaCanvas(targetImg);
            } catch (e2) {
                closeAllViewers();
                await sleep(300);
                log(`  [截图抓取] 附件 ${index + 1}: 下载失败 - ${e.message}`, 'warn');
                return null;
            }
        }

        const sizeKB = (blob.size / 1024).toFixed(1);
        log(`  [截图抓取] 附件 ${index + 1}: ${sizeKB}KB`);

        // 检查文件大小 —— 过滤图标占位符
        if (blob.size < DEFAULTS.minImageSize) {
            log(`  [截图抓取] 附件 ${index + 1} 太小 (${sizeKB}KB < ${(DEFAULTS.minImageSize / 1024).toFixed(1)}KB)，疑似占位符图标，跳过`, 'warn');
            closeAllViewers();
            await sleep(300);
            return null;
        }

        // 文件大小合格！压缩、缓存
        log(`  [截图抓取] 附件 ${index + 1} 文件大小合格 ✓`, 'success');
        const compressed = await compressImage(blob);
        const base64 = await blobToBase64(compressed);
        setCachedImage(customerId, base64);

        closeAllViewers();
        await sleep(500);

        log(`  [截图抓取] 成功获取截图 (原始 ${sizeKB}KB → 压缩后 ${(compressed.size / 1024).toFixed(1)}KB)`, 'success');
        return base64;
    }

    // ============================================================
    //  核心流程：抓取历史报备截图
    //  流程：点击客户姓名 → 抽屉 → 切换"客户信息"tab → 找"报备记录"附件
    //        → 点击打开查看器 → 下载 → 核查文件大小（过滤图标占位符）
    // ============================================================
    async function captureScreenshotFromHistory(customerRow, customerId) {
        log(`  [截图抓取] 开始为客户 ${customerId} 抓取历史截图...`);

        const cached = getCachedImage(customerId);
        if (cached) {
            log(`  [截图抓取] 命中缓存，直接使用`);
            return cached;
        }

        // === 第1步：点击客户姓名打开抽屉 ===
        const nameEl = customerRow.querySelector(SEL.customerName);
        if (!nameEl) {
            throw new Error('未找到客户姓名元素，无法打开抽屉');
        }

        log(`  [截图抓取] 点击客户姓名打开抽屉...`);
        simulateClick(nameEl);
        await sleep(800);

        // === 第2步：等待抽屉出现 ===
        let drawer;
        try {
            drawer = await waitForElement(SEL.drawer, 8000);
        } catch (e) {
            throw new Error('抽屉未出现（点击客户姓名后未检测到 .ant-drawer-content）');
        }
        log(`  [截图抓取] 抽屉已打开`);
        await sleep(1500); // 等抽屉内容渲染完

        // === 第3步：切换到"客户信息"tab ===
        const switched = await switchDrawerTab('客户信息');
        if (switched) {
            log(`  [截图抓取] 已切换到"客户信息"tab`);
        } else {
            log(`  [截图抓取] 未找到"客户信息"tab，在当前内容中查找附件...`, 'warn');
        }
        await sleep(1000);

        // === 第4步：找到报备记录区域的附件 ===
        const attachments = findAttachmentsInDrawer();

        if (attachments.length === 0) {
            // 诊断输出
            const drawerText = drawer ? drawer.textContent.substring(0, 800) : '';
            console.log('[睿美云补报] 抽屉文本(前800字符):', drawerText);
            const drawerHtml = drawer ? drawer.innerHTML.substring(0, 800) : '';
            console.log('[睿美云补报] 抽屉HTML(前800字符):', drawerHtml);
            log(`  [截图抓取] 报备记录中未找到附件`, 'warn');
            log(`  [截图抓取] 请用 DOM 检查模式打开抽屉→客户信息→报备记录，点击附件元素`, 'warn');
            closeDrawer();
            await sleep(500);
            throw new Error('报备记录中未找到附件图片');
        }

        log(`  [截图抓取] 找到 ${attachments.length} 个附件，逐个检查文件大小（过滤占位符图标）...`);

        // === 第5步：遍历附件，找到第一个文件大小合格的 ===
        let result = null;
        for (let i = 0; i < attachments.length; i++) {
            try {
                result = await downloadAttachment(attachments[i], i, attachments.length, customerId);
                if (result) break;
            } catch (e) {
                log(`  [截图抓取] 附件 ${i + 1} 异常: ${e.message}`, 'warn');
            }
        }

        // 关闭抽屉
        closeDrawer();
        await sleep(500);

        if (!result) {
            throw new Error(`所有 ${attachments.length} 个附件都太小（疑似占位符图标），无有效截图`);
        }

        return result;
    }

    // ============================================================
    //  核心流程：填写报备表单
    // ============================================================
    async function fillReportForm(customerRow, customerId, phone, imageBase64) {
        log(`  [表单填写] 开始填写报备表单...`);

        let reportBtn = null;

        // 策略1：行内用选择器查找
        if (SEL.btnReport) {
            reportBtn = customerRow.querySelector(SEL.btnReport);
        }

        // 策略2：行内按文字查找
        if (!reportBtn) {
            const allBtns = customerRow.querySelectorAll('button, a, span[role="button"], .ant-btn, td span, td .csp');
            for (const btn of allBtns) {
                const text = btn.textContent.trim();
                if (text === '报备' || text === '补备' || text.includes('报备') || text.includes('补报') || text.includes('新增目标')) {
                    reportBtn = btn;
                    log(`  [表单填写] 行内按文字找到按钮: "${text}"`, 'success');
                    break;
                }
            }
        }

        // 策略3：全局查找（可能在工具栏而非行内）
        if (!reportBtn) {
            log(`  [表单填写] 行内未找到报备按钮，尝试全局查找...`, 'warn');
            const globalBtns = $qa('button, a, span[role="button"], .ant-btn, .table_actionButton-primary');
            for (const btn of globalBtns) {
                const text = btn.textContent.trim();
                if (text.includes('报备') || text.includes('补报') || text.includes('新增目标')) {
                    reportBtn = btn;
                    log(`  [表单填写] 全局找到报备按钮: "${text}"`, 'success');
                    break;
                }
            }
        }

        // 策略4：按 class 查找（用户之前找到的 table_actionButton-primary）
        if (!reportBtn) {
            reportBtn = $q('button.table_actionButton-primary') || $q('.table_actionButton-primary');
            if (reportBtn) {
                log(`  [表单填写] 通过 table_actionButton-primary 找到按钮`, 'success');
            }
        }

        if (!reportBtn) {
            // 输出诊断信息
            const rowBtns = customerRow.querySelectorAll('button, a, .ant-btn, span.csp');
            const rowBtnTexts = Array.from(rowBtns).map(b => `"${b.textContent.trim()}"`).join(', ');
            log(`  [表单填写] 行内按钮: ${rowBtnTexts || '(无)'}`, 'warn');
            throw new Error('未找到报备按钮 — 请点击"扫描页面所有按钮"诊断');
        }

        log(`  [表单填写] 点击报备按钮: "${reportBtn.textContent.trim()}"...`);
        simulateClick(reportBtn);

        await sleep(1000);
        try {
            await waitForElement(SEL.reportModal, 8000);
        } catch (e) {
            throw new Error('报备表单弹窗未出现');
        }
        await sleep(800);

        const phoneInput = $q(SEL.reportFormPhone);
        if (phoneInput && phone) {
            setReactInputValue(phoneInput, phone);
            log(`  [表单填写] 手机号已填: ${phone}`);
            await sleep(500);

            // 触发系统自动填充（客户姓名、客户来源、目标报备人/部门）
            // 手动操作时"点击输入框外空白处"系统就会自动填入
            // 脚本模拟：点击弹窗标题区（非交互元素），绝不用 blur()（会导致焦点跳到客户来源 radio）
            // 也绝不点击 modal-body（里面包含 radio/select 等可交互元素）
            const modal = $q(SEL.reportModal);
            const header = modal?.querySelector('.ant-modal-header')
                || modal?.querySelector('.ant-modal-title');
            if (header) {
                // 只 dispatch mousedown + click 到 header，不转移焦点
                try {
                    header.dispatchEvent(new ctx.win.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                    header.dispatchEvent(new ctx.win.MouseEvent('click', { bubbles: true, cancelable: true }));
                } catch(e) {}
                log(`  [表单填写] 已点击弹窗标题区触发系统自动填充`);
            }
            await sleep(2500);
        }

        // === 科室选择（报备项目 TreeSelect 复选框模式）===
        // 一次性打开下拉、连续勾选"皮肤科"+"注射科"、最后关闭
        try {
            await selectDepartments(DEFAULTS.departments);
        } catch (e) {
            log(`  [表单填写] 科室勾选失败: ${e.message}`, 'warn');
        }

        // 关闭下拉（点击空白处或按 Escape）
        await closeTreeSelectDropdown();

        if (imageBase64) {
            try {
                // 检查上传按钮是否存在（用于诊断）
                const uploadBtn = $q(SEL.reportFormImageBtn);
                if (uploadBtn) {
                    log(`  [表单填写] 找到上传按钮: ${SEL.reportFormImageBtn}`);
                } else {
                    log(`  [表单填写] 未找到上传按钮，尝试直接查找 file input...`, 'warn');
                }

                const file = base64ToFile(imageBase64, `report_${customerId}.jpg`);
                triggerFileUpload(SEL.fileInput, file);
                log(`  [表单填写] 截图已上传`);
                await sleep(2000);
            } catch (e) {
                log(`  [表单填写] 截图上传失败: ${e.message}`, 'error');
                throw e;
            }
        }

        log(`  [表单填写] 表单填写完成`);
    }

    // ============================================================
    //  核心流程：提交报备
    // ============================================================
    async function submitReport() {
        log(`  [提交报备] 点击保存按钮...`);

        // 刷新上下文，防止 iframe 导航后 ctx.doc 引用过期
        refreshContext();
        if (!ctx.ready || !ctx.doc) {
            throw new Error('iframe 上下文未就绪');
        }

        // 查找报备弹窗（排除图片查看器 .ngslider，避免误匹配）
        const allModals = Array.from(ctx.doc.querySelectorAll(SEL.reportModal));
        const modal = allModals.find(m => !m.classList.contains('ngslider')) || allModals[0] || null;
        let submitBtn = null;

        // 策略0：用 F12 审查元素确认的精确 CSS 路径直接查找
        // 路径: .ant-modal-wrap.ngModal.ant-modal-centered > .ant-modal-content > .ant-modal-body > .mt-14.pr-20 > button.primary_btn
        submitBtn = ctx.doc.querySelector(
            '.ant-modal-wrap.ngModal.ant-modal-centered:not(.ngslider) .mt-14.pr-20 button.primary_btn'
        );
        if (submitBtn) {
            log(`  [提交报备] 精确定位保存按钮: "${submitBtn.textContent.trim()}"`, 'success');
        }

        // 策略1：在报备弹窗内查找 button.primary_btn，且验证文字含"保存"（排除搜索按钮）
        if (modal) {
            const btns = modal.querySelectorAll('button.primary_btn');
            for (const b of btns) {
                const text = b.textContent.trim().replace(/\s/g, '');
                if (text.includes('保存') || text === '确定' || text === '提交') {
                    submitBtn = b;
                    log(`  [提交报备] 弹窗内找到保存按钮: "${b.textContent.trim()}"`, 'success');
                    break;
                }
            }
        }

        // 策略2：弹窗内按文字"保存"查找（不限 class）
        if (!submitBtn && modal) {
            const btns = modal.querySelectorAll('button');
            for (const b of btns) {
                const text = b.textContent.trim().replace(/\s/g, '');
                if (text === '保存' || text === '确定' || text === '提交') {
                    submitBtn = b;
                    log(`  [提交报备] 通过文字"${text}"找到保存按钮`, 'success');
                    break;
                }
            }
        }

        // 策略3：全局查找 primary 按钮（排除搜索/查询/筛选按钮）
        if (!submitBtn) {
            const allBtns = Array.from(ctx.doc.querySelectorAll('button.ant-btn-primary:not(.ant-btn-disabled)'));
            for (const b of allBtns) {
                const text = b.textContent.trim().replace(/\s/g, '');
                // 排除搜索/查询/筛选按钮
                if (text.includes('搜') || text.includes('查') || text.includes('筛')) continue;
                if (text.includes('保存') || text === '确定' || text === '提交') {
                    submitBtn = b;
                    log(`  [提交报备] 全局找到保存按钮: "${b.textContent.trim()}"`, 'warn');
                    break;
                }
            }
        }

        if (!submitBtn) {
            // 诊断：输出弹窗内所有按钮
            if (modal) {
                const btns = modal.querySelectorAll('button');
                const btnTexts = Array.from(btns).map(b => `"${b.textContent.trim()}"(class:${b.className.substring(0, 50)})`).join(', ');
                log(`  [提交报备] 弹窗内按钮: ${btnTexts}`, 'warn');
            }
            throw new Error('未找到保存按钮');
        }

        log(`  [提交报备] 找到按钮: "${submitBtn.textContent.trim()}" class="${submitBtn.className.substring(0, 60)}"`);

        if (submitBtn.disabled || submitBtn.classList.contains('ant-btn-disabled')) {
            log(`  [提交报备] 保存按钮不可用，等待 2s...`, 'warn');
            await sleep(2000);
        }

        // 滚动到可见区域
        try { submitBtn.scrollIntoView({ block: 'center' }); } catch(e) {}
        await sleep(300);

        // 先用 simulateClick（完整事件链）
        simulateClick(submitBtn);
        await sleep(800);

        // 检测保存是否成功：出现成功 toast，或弹窗自动关闭
        let saved = false;
        let successMsgText = '';
        let errorMsgText = '';
        const saveStartTs = Date.now();

        while (Date.now() - saveStartTs < 5000) {
            const successMsg = findElementByText('.ant-message-notice-content, .ant-notification-notice-content, .ant-message', '成功');
            if (successMsg) {
                saved = true;
                successMsgText = successMsg.textContent.trim();
                break;
            }

            // 弹窗自动关闭也是保存成功的一个标志
            const modalsNow = Array.from(ctx.doc.querySelectorAll(SEL.reportModal));
            const reportModalOpen = modalsNow.find(m => !m.classList.contains('ngslider'));
            if (!reportModalOpen) {
                saved = true;
                successMsgText = '弹窗已关闭';
                break;
            }

            // 检测失败 toast 或表单校验错误
            const errorMsg = findElementByText('.ant-message-notice-content, .ant-notification-notice-content, .ant-message', '失败');
            const formError = ctx.doc.querySelector('.ant-form-item-explain-error');
            if (errorMsg) errorMsgText = errorMsg.textContent.trim();
            else if (formError) errorMsgText = formError.textContent.trim();
            if (errorMsgText) break;

            await sleep(500);
        }

        // 如果既没成功也没明确失败，再点一次原生 click 兜底
        if (!saved && !errorMsgText) {
            const modalsNow = Array.from(ctx.doc.querySelectorAll(SEL.reportModal));
            const reportModalOpen = modalsNow.find(m => !m.classList.contains('ngslider'));
            if (reportModalOpen) {
                log(`  [提交报备] simulateClick 后弹窗仍在，用原生 click() 重试...`, 'warn');
                submitBtn.click();
                await sleep(1500);

                // 再次检测成功
                const successMsg = findElementByText('.ant-message-notice-content, .ant-notification-notice-content, .ant-message', '成功');
                if (successMsg) {
                    saved = true;
                    successMsgText = successMsg.textContent.trim();
                } else {
                    const modalsNow2 = Array.from(ctx.doc.querySelectorAll(SEL.reportModal));
                    const reportModalOpen2 = modalsNow2.find(m => !m.classList.contains('ngslider'));
                    if (!reportModalOpen2) {
                        saved = true;
                        successMsgText = '弹窗已关闭';
                    }
                }
            }
        }

        if (!saved) {
            // 收集所有校验错误
            const modal = $q(SEL.reportModal);
            const formErrors = modal ? Array.from(modal.querySelectorAll('.ant-form-item-explain-error')).map(e => e.textContent.trim()) : [];
            const errorDetail = errorMsgText || formErrors.join('; ') || '保存失败但无明确错误信息';
            log(`  [提交报备] 保存失败: ${errorDetail}`, 'error');
            // 不 closeModal，让用户看到未保存的弹窗和错误信息
            throw new Error(`保存失败: ${errorDetail}`);
        }

        log(`  [提交报备] 保存成功: ${successMsgText}`, 'success');
        // 成功后再关闭弹窗（如果还开着）
        const modalsFinal = Array.from(ctx.doc.querySelectorAll(SEL.reportModal));
        const reportModalFinal = modalsFinal.find(m => !m.classList.contains('ngslider'));
        if (reportModalFinal) {
            closeModal();
        }
        log(`  [提交报备] 提交完成`);
        return true;
    }

    // ============================================================
    //  处理单个客户
    // ============================================================
    async function processSingleCustomer(customerRow, options = {}) {
        const { skipConfirm = false } = options;

        const customerId = customerRow.getAttribute(SEL.customerIdAttr) ||
                          customerRow.dataset.rowKey ||
                          customerRow.getAttribute('data-id') || '';
        const nameEl = customerRow.querySelector(SEL.customerName);
        const phoneEl = customerRow.querySelector(SEL.customerPhone);
        const customerName = nameEl ? nameEl.textContent.trim() : '未知客户';
        // 手机号：span.csp.mainColor 的 textContent 可能同时包含客户名和手机号
        // 用正则提取 11 位号码（1 开头），避免客户名中的数字被拼入
        const rawPhoneText = phoneEl ? phoneEl.textContent.trim() : '';
        const phoneMatch = rawPhoneText.match(/1\d{10}/);
        const phone = phoneMatch ? phoneMatch[0] : rawPhoneText.replace(/\D/g, '');

        log(`处理客户: ${customerName} (ID: ${customerId}, 手机: ${phone || '无'})`);

        if (!skipConfirm) {
            const confirmed = confirm(`确认对客户【${customerName}】进行补报吗？`);
            if (!confirmed) {
                log(`用户取消，终止操作`, 'warn');
                return { status: 'cancelled' };
            }
        }

        try {
            let imageBase64 = null;
            try {
                imageBase64 = await captureScreenshotFromHistory(customerRow, customerId);
            } catch (e) {
                log(`  截图抓取失败: ${e.message}`, 'warn');
                const proceed = confirm(
                    `未找到客户【${customerName}】的历史报备截图。\n${e.message}\n\n点击「确定」手动上传，点击「取消」跳过该客户。`
                );
                if (!proceed) {
                    return { status: 'skipped', reason: e.message };
                }
            }

            await fillReportForm(customerRow, customerId, phone, imageBase64);
            await submitReport();

            log(`客户【${customerName}】补报成功!`, 'success');
            return { status: 'success' };
        } catch (e) {
            log(`客户【${customerName}】补报失败: ${e.message}`, 'error');
            closeModal();
            await sleep(500);
            return { status: 'failed', reason: e.message };
        }
    }

    // ============================================================
    //  批量处理
    // ============================================================
    async function processBatchCustomers() {
        if (state.running) {
            log('已有任务在运行中', 'warn');
            return;
        }

        refreshContext();
        if (!ctx.ready) {
            alert('iframe 未就绪，请等待页面加载完成后重试');
            return;
        }

        const checkedBoxes = ctx.doc.querySelectorAll('input.rmh-batch-cb:checked');
        if (checkedBoxes.length === 0) {
            alert('请至少勾选一个客户！');
            return;
        }

        const confirmed = confirm(`确认对 ${checkedBoxes.length} 个客户进行批量补报？\n\n点击「取消」将终止整个批量流程。\n开始后将自动依次处理所有勾选客户，无需手动确认。`);
        if (!confirmed) {
            log('批量补报已取消', 'warn');
            return;
        }

        state.running = true;
        state.batchResults = { success: 0, failed: 0, skipped: 0 };
        setButtonsDisabled(true);
        updateStatus('处理中...', '#2f54eb');

        log(`========== 批量补报开始（共 ${checkedBoxes.length} 个客户）==========`);

        for (let i = 0; i < checkedBoxes.length; i++) {
            const checkbox = checkedBoxes[i];
            const row = checkbox.closest('tr') || checkbox.closest('[class*="row"]');
            if (!row) {
                log(`  [${i + 1}/${checkedBoxes.length}] 无法定位客户行，跳过`, 'warn');
                state.batchResults.skipped++;
                continue;
            }

            const nameEl = row.querySelector(SEL.customerName);
            const customerName = nameEl ? nameEl.textContent.trim() : `客户${i + 1}`;

            log(`--- [${i + 1}/${checkedBoxes.length}] 处理: ${customerName} ---`);

            // v3.4: 移除每个客户处理前的二次确认弹窗，实现批量自动化
            // （首个总确认弹窗已在外层处理，此处直接执行）

            // 每次处理前刷新上下文（防止 iframe 导航导致引用失效）
            refreshContext();

            const result = await processSingleCustomer(row, { skipConfirm: true });

            if (result.status === 'success') state.batchResults.success++;
            else if (result.status === 'skipped') state.batchResults.skipped++;
            else state.batchResults.failed++;

            updateBatchProgress(i + 1, checkedBoxes.length);

            if (i < checkedBoxes.length - 1) {
                await sleep(DEFAULTS.requestDelay);
            }
        }

        log(`========== 批量补报结束 ==========`, 'success');
        log(`成功: ${state.batchResults.success} | 失败: ${state.batchResults.failed} | 跳过: ${state.batchResults.skipped}`);

        notify('批量补报完成', `成功 ${state.batchResults.success}，失败 ${state.batchResults.failed}，跳过 ${state.batchResults.skipped}`);

        state.running = false;
        setButtonsDisabled(false);
        updateStatus('就绪', '#52c41a');

        // 不再刷新页面/跳转，仅确保报备弹窗已关闭
        closeModal();
    }

    // ============================================================
    //  UI 注入 —— 控制面板（注入到顶层文档，固定在屏幕上方）
    // ============================================================
    function injectControlPanel() {
        if (document.getElementById('rmh-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'rmh-panel';
        panel.style.cssText = [
            'position: fixed', 'top: 12px', 'right: 12px', 'width: 290px',
            'background: #fff', 'border: 2px solid #2f54eb', 'border-radius: 10px',
            'box-shadow: 0 4px 20px rgba(0,0,0,0.15)', 'z-index: 2147483647',
            'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            'font-size: 13px', 'padding: 14px',
        ].join(';');

        panel.innerHTML = `
            <div id="rmh-panel-header" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;cursor:move;user-select:none;">
                <span style="font-weight:600;font-size:14px;color:#26215c;">睿美云补报助手 v3.4</span>
                <span style="display:flex;align-items:center;gap:6px;">
                    <span id="rmh-btn-minimize" title="最小化/展开" style="cursor:pointer;font-size:15px;color:#595959;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;border-radius:4px;line-height:1;background:#f0f0f0;border:1px solid #d9d9d9;">—</span>
                    <span id="rmh-status-dot" style="width:10px;height:10px;border-radius:50%;background:#ff4d4f;display:inline-block;"></span>
                </span>
            </div>
            <div id="rmh-panel-body">
                <div id="rmh-status" style="font-size:11px;color:#ff4d4f;margin-bottom:8px;padding:3px 6px;background:#fff1f0;border-radius:4px;">
                    等待 iframe...
                </div>
                <button id="rmh-btn-batch" class="rmh-btn" style="display:block;width:100%;margin-bottom:6px;padding:8px;
                    border:1px solid #d9d9d9;border-radius:6px;background:#f0f5ff;cursor:pointer;color:#2f54eb;font-weight:500;font-size:13px;">
                    批量补报选中客户
                </button>
                <button id="rmh-btn-inspector" class="rmh-btn" style="display:block;width:100%;margin-bottom:6px;padding:8px;
                    border:1px solid #d9d9d9;border-radius:6px;background:#fafafa;cursor:pointer;color:#595959;font-size:13px;">
                    DOM 检查模式: 关
                </button>
                <button id="rmh-btn-scan" class="rmh-btn" style="display:block;width:100%;margin-bottom:6px;padding:6px;
                    border:1px solid #d9d9d9;border-radius:6px;background:#fff7e6;cursor:pointer;color:#fa8c16;font-size:12px;">
                    扫描页面所有按钮
                </button>
                <button id="rmh-btn-reinject" class="rmh-btn" style="display:block;width:100%;margin-bottom:6px;padding:6px;
                    border:1px solid #d9d9d9;border-radius:6px;background:#fafafa;cursor:pointer;color:#8c8c8c;font-size:12px;">
                    重新检测页面
                </button>
                <div id="rmh-progress" style="display:none;margin-bottom:8px;padding:6px;background:#f6ffed;
                    border-radius:4px;font-size:12px;color:#52c41a;"></div>
                <div style="margin-top:8px;padding-top:8px;border-top:1px solid #f0f0f0;">
                    <div id="rmh-stats" style="color:#8c8c8c;margin-bottom:4px;">就绪</div>
                    <div id="rmh-log" style="max-height:200px;overflow-y:auto;font-size:11px;color:#595959;
                        background:#fafafa;padding:6px;border-radius:4px;line-height:1.6;font-family:monospace;">
                        日志区域
                    </div>
                </div>
            </div>
        `;

        const style = document.createElement('style');
        style.textContent = `
            .rmh-btn:hover { border-color: #40a9ff !important; }
            .rmh-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        `;
        document.head.appendChild(style);
        document.body.appendChild(panel);

        document.getElementById('rmh-btn-batch').addEventListener('click', processBatchCustomers);
        document.getElementById('rmh-btn-inspector').addEventListener('click', toggleInspector);
        document.getElementById('rmh-btn-scan').addEventListener('click', scanAllButtons);
        document.getElementById('rmh-btn-reinject').addEventListener('click', () => {
            refreshContext();
            if (ctx.ready) {
                injectStylesIntoIframe();
                injectCheckboxes();
                setupObserver();
                updateStatus('iframe 就绪', '#52c41a');
                log('手动重新检测完成');
            } else {
                updateStatus('iframe 仍未就绪', '#ff4d4f');
                log('iframe 仍未就绪', 'error');
            }
        });

        // ===== 最小化/展开 =====
        const btnMin = document.getElementById('rmh-btn-minimize');
        btnMin.addEventListener('click', (e) => {
            e.stopPropagation();
            const body = document.getElementById('rmh-panel-body');
            const isHidden = body.style.display === 'none';
            body.style.display = isHidden ? '' : 'none';
            btnMin.textContent = isHidden ? '—' : '+';
            btnMin.title = isHidden ? '最小化' : '展开';
            try { GM_setValue('rmh_minimized', !isHidden); } catch (err) {}
        });
        btnMin.addEventListener('mousedown', (e) => { e.stopPropagation(); });

        // 恢复最小化状态
        try {
            if (GM_getValue('rmh_minimized', false)) {
                document.getElementById('rmh-panel-body').style.display = 'none';
                btnMin.textContent = '+';
                btnMin.title = '展开';
            }
        } catch (err) {}

        // ===== 拖拽移动 =====
        const header = document.getElementById('rmh-panel-header');
        let dragging = false, dragOffsetX = 0, dragOffsetY = 0;

        header.addEventListener('mousedown', (e) => {
            // 点最小化按钮不触发拖拽
            if (e.target.id === 'rmh-btn-minimize') return;
            dragging = true;
            const rect = panel.getBoundingClientRect();
            dragOffsetX = e.clientX - rect.left;
            dragOffsetY = e.clientY - rect.top;
            panel.style.transition = 'none';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            let newLeft = e.clientX - dragOffsetX;
            let newTop = e.clientY - dragOffsetY;
            // 限制在视口范围内
            newLeft = Math.max(2, Math.min(window.innerWidth - panel.offsetWidth - 2, newLeft));
            newTop = Math.max(2, Math.min(window.innerHeight - 40, newTop));
            panel.style.left = newLeft + 'px';
            panel.style.top = newTop + 'px';
            panel.style.right = 'auto';
        });

        document.addEventListener('mouseup', () => {
            if (dragging) {
                dragging = false;
                // 保存位置
                try {
                    GM_setValue('rmh_pos', { left: panel.style.left, top: panel.style.top });
                } catch (err) {}
            }
        });

        // 恢复上次位置
        try {
            const savedPos = GM_getValue('rmh_pos', null);
            if (savedPos && savedPos.left && savedPos.top) {
                // 确保不会拖出当前视口（窗口可能缩小了）
                const leftNum = parseInt(savedPos.left) || 0;
                const topNum = parseInt(savedPos.top) || 0;
                if (leftNum < window.innerWidth - 50 && topNum < window.innerHeight - 40) {
                    panel.style.left = savedPos.left;
                    panel.style.top = savedPos.top;
                    panel.style.right = 'auto';
                }
            }
        } catch (err) {}

        console.log('[睿美云补报 v3.4] 控制面板已注入到顶层文档（支持拖拽+最小化+按钮扫描+报备记录附件图标）');
    }

    // ============================================================
    //  UI 注入 —— 样式注入到 iframe（检查器高亮、复选框）
    // ============================================================
    function injectStylesIntoIframe() {
        if (!ctx.doc) return;
        if (ctx.doc.getElementById('rmh-iframe-styles')) return;
        const style = ctx.doc.createElement('style');
        style.id = 'rmh-iframe-styles';
        style.textContent = `
            .rmh-batch-cb { margin: 0 4px !important; cursor: pointer !important; accent-color: #2f54eb !important; vertical-align: middle !important; }
            .rmh-inspector-highlight { outline: 2px solid #ff4d4f !important; outline-offset: -2px !important; }
            .rmh-inspector-active * { cursor: crosshair !important; }
        `;
        ctx.doc.head.appendChild(style);
    }

    // ============================================================
    //  UI 注入 —— 复选框（注入到 iframe 内客户列表表格行）
    //  关键改进：
    //   1. 排除抽屉/弹窗内的表格行（只注入客户列表）
    //   2. 只给包含客户姓名(span.fw-b)的行注入（确认是客户行）
    //   3. 复选框放在客户姓名前面（而非第一个 td）
    //   4. 全选按钮也排除抽屉/弹窗
    // ============================================================
    function isCustomerListRow(row) {
        // 排除抽屉/弹窗内的行
        if (row.closest('.ant-drawer-content, .ant-modal-wrap, .ant-modal-content, .ant-modal')) {
            return false;
        }
        // 必须包含客户姓名元素
        if (!row.querySelector(SEL.customerName)) {
            return false;
        }
        return true;
    }

    function injectCheckboxes() {
        if (!ctx.ready || !ctx.doc) return 0;

        injectStylesIntoIframe();

        const allRows = ctx.doc.querySelectorAll(SEL.tableRow);
        let injected = 0;

        for (const row of allRows) {
            if (!isCustomerListRow(row)) continue;
            if (row.querySelector('.rmh-batch-cb')) continue;

            // 找到客户姓名所在的 cell，把复选框放在姓名前面
            const nameEl = row.querySelector(SEL.customerName);
            const nameCell = nameEl ? nameEl.closest('td') : null;
            if (!nameCell) continue;

            const cb = ctx.doc.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'rmh-batch-cb';
            cb.title = '勾选后可批量补报';
            nameCell.insertBefore(cb, nameCell.firstChild);
            injected++;
        }

        // 表头全选 —— 只注入到客户列表表格的表头（排除抽屉/弹窗）
        const headers = ctx.doc.querySelectorAll(SEL.tableHeader);
        for (const header of headers) {
            if (header.closest('.ant-drawer-content, .ant-modal-wrap, .ant-modal-content, .ant-modal')) continue;
            if (header.querySelector('.rmh-batch-cb-all')) continue;

            const allCb = ctx.doc.createElement('input');
            allCb.type = 'checkbox';
            allCb.className = 'rmh-batch-cb-all';
            allCb.style.cssText = 'margin: 0 4px; cursor: pointer; vertical-align: middle; accent-color: #2f54eb;';
            allCb.addEventListener('change', () => {
                if (!ctx.doc) return;
                ctx.doc.querySelectorAll('.rmh-batch-cb').forEach(cb => {
                    // 只勾选客户列表中的复选框（排除抽屉/弹窗）
                    if (!cb.closest('.ant-drawer-content, .ant-modal-wrap, .ant-modal-content, .ant-modal')) {
                        cb.checked = allCb.checked;
                    }
                });
            });
            header.insertBefore(allCb, header.firstChild);
            break; // 只注入第一个匹配的客户列表表头
        }

        if (injected > 0) {
            log(`已为 ${injected} 行注入复选框`);
        }
        return injected;
    }

    function setButtonsDisabled(disabled) {
        document.querySelectorAll('.rmh-btn').forEach(el => {
            el.disabled = disabled;
        });
    }

    function updateBatchProgress(current, total) {
        const el = document.getElementById('rmh-progress');
        if (el) {
            el.style.display = 'block';
            el.textContent = `进度: ${current}/${total} | 成功 ${state.batchResults.success} | 失败 ${state.batchResults.failed} | 跳过 ${state.batchResults.skipped}`;
        }
        const stats = document.getElementById('rmh-stats');
        if (stats) {
            stats.textContent = `处理中 ${current}/${total}`;
        }
    }

    // ============================================================
    //  诊断：扫描 iframe 内所有按钮/可点击元素
    //  帮助找到补报按钮的确切位置和选择器
    // ============================================================
    function scanAllButtons() {
        if (!ctx.ready || !ctx.doc) {
            log('iframe 未就绪，无法扫描', 'error');
            return;
        }

        log('========== 开始扫描页面按钮 ==========', 'warn');

        const clickables = ctx.doc.querySelectorAll(
            'button, a, span[role="button"], .ant-btn, [class*="action"], [class*="btn"], [class*="Button"], td span.csp, td .csp'
        );

        log(`共扫描 ${clickables.length} 个可点击元素`);

        const keywords = ['报备', '补报', '新增', '目标', '上报', '提交', '联系'];
        const reportBtns = [];
        const visibleBtns = [];

        clickables.forEach((el, i) => {
            // 跳过我们注入的元素
            if (el.className && typeof el.className === 'string' && el.className.includes('rmh-')) return;

            const text = el.textContent.trim().substring(0, 40);
            const tag = el.tagName.toLowerCase();
            const id = el.id ? `#${el.id}` : '';
            const cls = (typeof el.className === 'string')
                ? `.${el.className.split(/\s+/).filter(c => c).join('.')}`
                : '';
            const rect = el.getBoundingClientRect();
            const visible = rect.width > 0 && rect.height > 0;
            const selector = tag + id + cls;

            const isRelevant = keywords.some(kw => text.includes(kw));

            if (isRelevant) {
                reportBtns.push({ el, text, selector, visible, i });
            }
            if (visible && text) {
                visibleBtns.push({ text, selector, i });
            }
        });

        // 输出报备相关按钮
        if (reportBtns.length > 0) {
            log(`★★★ 找到 ${reportBtns.length} 个报备相关按钮：`, 'success');
            reportBtns.forEach(b => {
                const visMark = b.visible ? '' : ' [隐藏]';
                log(`  ★ [${b.i}] "${b.text}"${visMark}`, 'success');
                log(`    选择器: ${b.selector}`, 'success');
                console.log(`[睿美云补报-扫描] ★ 按钮 #${b.i}:`, b.el,
                    `\n  文字: ${b.text}\n  选择器: ${b.selector}\n  可见: ${b.visible}`);
            });
        } else {
            log('✗ 未找到包含"报备/补报/新增/目标"文字的按钮', 'warn');
        }

        // 输出所有可见按钮（前30个）
        log(`--- 所有可见按钮（共 ${visibleBtns.length} 个，显示前30个）---`);
        visibleBtns.slice(0, 30).forEach(b => {
            log(`  [${b.i}] "${b.text}" → ${b.selector}`);
        });

        if (visibleBtns.length > 30) {
            log(`  ... 还有 ${visibleBtns.length - 30} 个，详见控制台`);
        }

        // 额外检查：表格行内的操作列
        const rows = ctx.doc.querySelectorAll(SEL.tableRow);
        if (rows.length > 0) {
            const firstRow = rows[0];
            const rowBtns = firstRow.querySelectorAll('button, a, .ant-btn, span.csp, [class*="action"]');
            log(`--- 第一行内有 ${rowBtns.length} 个可点击元素 ---`);
            rowBtns.forEach((btn, i) => {
                const text = btn.textContent.trim().substring(0, 30) || '(无文字)';
                const cls = (typeof btn.className === 'string') ? btn.className : '';
                const rect = btn.getBoundingClientRect();
                const vis = rect.width > 0 ? '可见' : '隐藏';
                log(`  行内[${i}] "${text}" [${vis}] class="${cls}"`);
                console.log(`[睿美云补报-扫描] 行内按钮[${i}]:`, btn);
            });

            // 检查表格是否有横向滚动
            const tableContent = ctx.doc.querySelector('.ant-table-content, .ant-table-scroll');
            if (tableContent) {
                const scrollWidth = tableContent.scrollWidth;
                const clientWidth = tableContent.clientWidth;
                if (scrollWidth > clientWidth) {
                    log(`⚠ 表格有横向滚动！可滚动区域 ${scrollWidth}px > 可见区域 ${clientWidth}px`, 'warn');
                    log(`  操作列可能在右侧，需要横向滚动才能看到`, 'warn');
                }
            }
        }

        log('========== 扫描完成 ==========', 'warn');
        log('详细结果已输出到浏览器控制台 (F12 → Console)', 'info');
    }

    // ============================================================
    //  DOM 检查模式（操作 iframe 内文档）
    // ============================================================
    function toggleInspector() {
        if (!ctx.ready || !ctx.doc) {
            log('iframe 未就绪，无法开启检查模式', 'error');
            return;
        }

        state.inspectorMode = !state.inspectorMode;
        const btn = document.getElementById('rmh-btn-inspector');

        if (state.inspectorMode) {
            btn.textContent = 'DOM 检查模式: 开';
            btn.style.background = '#fff1f0';
            btn.style.color = '#ff4d4f';
            ctx.doc.body.classList.add('rmh-inspector-active');
            ctx.doc.addEventListener('click', inspectorClickHandler, true);
            log('DOM 检查模式已开启 — 点击 iframe 内元素查看选择器', 'warn');
        } else {
            btn.textContent = 'DOM 检查模式: 关';
            btn.style.background = '#fafafa';
            btn.style.color = '#595959';
            if (ctx.doc) {
                ctx.doc.body.classList.remove('rmh-inspector-active');
                ctx.doc.removeEventListener('click', inspectorClickHandler, true);
                ctx.doc.querySelectorAll('.rmh-inspector-highlight').forEach(el => {
                    el.classList.remove('rmh-inspector-highlight');
                });
            }
            log('DOM 检查模式已关闭');
        }
    }

    function inspectorClickHandler(e) {
        e.preventDefault();
        e.stopPropagation();

        if (!ctx.doc) return false;

        ctx.doc.querySelectorAll('.rmh-inspector-highlight').forEach(el => {
            el.classList.remove('rmh-inspector-highlight');
        });

        const el = e.target;
        el.classList.add('rmh-inspector-highlight');

        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        const classes = el.className
            ? `.${el.className.split(/\s+/).filter(c => c && !c.startsWith('rmh-')).join('.')}`
            : '';
        const dataAttrs = Array.from(el.attributes)
            .filter(a => a.name.startsWith('data-'))
            .map(a => `${a.name}="${a.value}"`)
            .join(' ');

        let selector = tag + id + classes;

        const row = el.closest('tr');
        const rowInfo = row ? ` | 所在行 data-row-key: ${row.getAttribute('data-row-key') || 'N/A'}` : '';

        const info = [
            `元素: ${selector}`,
            `标签: <${tag}>`,
            `文本: ${el.textContent.trim().substring(0, 50)}`,
            `类名: ${el.className || '(无)'}`,
            dataAttrs ? `属性: ${dataAttrs}` : '',
            rowInfo,
        ].filter(Boolean).join('\n');

        console.log('[睿美云补报 - DOM检查]', info);
        log(`DOM检查: ${selector}\n  文本: ${el.textContent.trim().substring(0, 40)}`, 'warn');

        try {
            navigator.clipboard.writeText(selector);
            log('  选择器已复制到剪贴板', 'success');
        } catch (e) {}

        return false;
    }

    // ============================================================
    //  MutationObserver —— 监听 iframe 内表格变化
    // ============================================================
    let observer = null;

    function setupObserver() {
        if (observer) {
            try { observer.disconnect(); } catch(e) {}
        }
        if (!ctx.doc || !ctx.doc.body) return;

        // 用定时器去重（300ms 节流），比原来 2s 快很多
        // 翻页/筛选后表格重新渲染，新行能被快速注入复选框
        let injectTimer = null;
        observer = new MutationObserver(() => {
            if (state.running) return;
            if (injectTimer) return;
            injectTimer = setTimeout(() => {
                injectTimer = null;
                injectCheckboxes();
            }, 300);
        });
        observer.observe(ctx.doc.body, { childList: true, subtree: true });
        console.log('[睿美云补报 v3.4] MutationObserver 已挂载到 iframe body（300ms 节流）');
    }

    // ============================================================
    //  iframe 就绪处理
    // ============================================================
    function onIframeReady() {
        state.iframeReady = true;
        updateStatus('iframe 就绪', '#52c41a');

        const dot = document.getElementById('rmh-status-dot');
        if (dot) dot.style.background = '#52c41a';

        injectStylesIntoIframe();
        injectCheckboxes();
        setupObserver();

        log('iframe 已就绪！等待页面内容渲染...', 'success');
        log('就绪！勾选客户后点击「批量补报」', 'success');

        // 监听 iframe 导航（登录 → 应用切换）
        if (ctx.iframe) {
            ctx.iframe.addEventListener('load', () => {
                log('iframe 导航，重新检测...', 'warn');
                state.iframeReady = false;
                updateStatus('重新检测中...', '#faad14');
                setTimeout(() => {
                    if (refreshContext()) {
                        onIframeReady();
                    }
                }, 2000);
            });
        }
    }

    // ============================================================
    //  初始化
    // ============================================================
    function init() {
        console.log('[睿美云补报 v3.4] init() 开始, readyState=', document.readyState);

        // 立即注入面板到顶层文档
        injectControlPanel();
        log('脚本已加载，正在检测 iframe...');

        // 轮询检测 iframe 就绪
        let attempts = 0;
        const poll = setInterval(() => {
            attempts++;
            if (refreshContext()) {
                clearInterval(poll);
                console.log('[睿美云补报 v3.4] iframe 已就绪');
                onIframeReady();
            } else if (attempts % 10 === 0) {
                log(`等待 iframe... (${attempts}s)`, 'warn');
            }
            if (attempts > 120) {
                clearInterval(poll);
                log('未找到 iframe（120s 超时），请确认在睿美云页面', 'error');
                updateStatus('未找到 iframe', '#ff4d4f');
            }
        }, 1000);

        // 兜底：定期刷新上下文（防止 iframe 导航后引用失效）
        setInterval(() => {
            if (!state.running) {
                refreshContext();
                if (ctx.ready && !state.iframeReady) {
                    onIframeReady();
                }
            }
        }, 5000);
    }

    // 启动
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
