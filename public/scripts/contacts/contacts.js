// views/scripts/contacts.js
/**
 * ============================================================================
 * File: public/scripts/contacts/contacts.js
 * Version: v8.0.1 (Phase 8 UI Annotation)
 * Date: 2026-02-10
 * Author: Gemini (Assisted)
 *
 * Change Log:
 * - [Phase 8] Added World Model Annotation for RAW vs CORE separation.
 * - [Phase 8] Semantic identity clarification (comments only)
 * - Comments only, no behavior change.
 * * WORLD MODEL (UI LAYER):
 * 1. RAW Contact (Potential):
 * - Rendered here (loadContacts).
 * - Source: /api/contacts (Sheet Read).
 * - Action: Upgrade (triggers handoff to NewOppWizard).
 * - Identity: Uses rowIndex (passed in payload) for handoff.
 * * 2. CORE Contact (Official):
 * - NOT rendered here. Managed in separate Official List views.
 * - This file strictly handles the "Potential Pool" (Sheet Data).
 * ============================================================================
 */

/**
 * SEMANTIC IDENTITY (IMPORTANT):
 *
 * Although this file is named `contacts.js`, it does NOT represent
 * the CORE "Contact" domain.
 *
 * This module is SEMANTICALLY:
 * 👉 RAW / POTENTIAL CONTACT POOL UI
 *
 * Responsibilities:
 * - Render RAW contacts sourced from Google Sheets (OCR / business cards).
 * - Provide triage actions (view card, upgrade).
 * - Act as the handoff entry point into Opportunity / CORE workflows.
 *
 * Non-Responsibilities (by design):
 * - Does NOT render CORE (Official) Contacts.
 * - Does NOT manage SQL-backed Contact entities.
 * - Does NOT own Contact-Opportunity relationships.
 *
 * Rationale:
 * - RAW contacts are high-volume, unverified, and disposable.
 * - CORE contacts are curated entities and live in SQL with different UI.
 *
 * Naming Constraint:
 * - File name is kept as `contacts.js` for legacy routing stability.
 * - Semantic meaning is intentionally documented here to avoid misuse.
 */

// 職責：管理「潛在客戶列表」的渲染與操作 (Event Delegation Refactor)

// ==================== 全域變數 ====================
let allContactsData = []; 

// ==================== 主要功能函式 ====================

async function loadContacts(query = '') {
    const container = document.getElementById('page-contacts');
    if (!container) return;

    // 1. 初始化容器與事件監聽
    container.innerHTML = `
        <div id="contacts-dashboard-container" class="dashboard-grid-flexible" style="margin-bottom: 24px;">
            <div class="loading show" style="grid-column: span 12;"><div class="spinner"></div></div>
        </div>
        <div class="dashboard-widget">
            <div class="widget-header"><h2 class="widget-title">潛在客戶列表</h2></div>
            <div class="search-pagination" style="padding: 0 1.5rem; margin-bottom: 1rem;">
                <input type="text" class="search-box" id="contacts-page-search" placeholder="搜尋姓名或公司..." value="${query}">
            </div>
            <div id="contacts-page-content">
                <div class="loading show"><div class="spinner"></div><p>載入潛在客戶資料中...</p></div>
            </div>
        </div>
    `;

    // 移除舊監聽器並綁定新的 (事件委派核心)
    container.removeEventListener('click', handleContactListClick);
    container.addEventListener('click', handleContactListClick);

    // 綁定搜尋輸入
    const searchInput = document.getElementById('contacts-page-search');
    if (searchInput) {
        searchInput.addEventListener('keyup', searchContactsEvent);
    }

    try {
        if (allContactsData.length === 0) {
            console.log('[Contacts] 首次載入，正在獲取所有潛在客戶資料...');
            // [World Model] Fetching RAW Data from Sheet via API
            const [dashboardResult, listResult] = await Promise.all([
                authedFetch(`/api/contacts/dashboard`),
                authedFetch(`/api/contacts?q=`)
            ]);

            if (dashboardResult.success && dashboardResult.data && dashboardResult.data.chartData) {
                renderContactsDashboard(dashboardResult.data.chartData);
            } else {
                const dashboardContainer = document.getElementById('contacts-dashboard-container');
                 if(dashboardContainer) dashboardContainer.innerHTML = `<div class="alert alert-error" style="grid-column: span 12;">圖表資料載入失敗</div>`;
            }

            allContactsData = listResult.data || [];
        } else {
            // 使用快取資料，但仍嘗試更新圖表
            const dashboardResult = await authedFetch(`/api/contacts/dashboard`);
            if (dashboardResult.success && dashboardResult.data && dashboardResult.data.chartData) {
                renderContactsDashboard(dashboardResult.data.chartData);
            }
        }
        
        filterAndRenderContacts(query);

    } catch (error) {
        if (error.message !== 'Unauthorized') {
            const listContent = document.getElementById('contacts-page-content');
            if(listContent) listContent.innerHTML = `<div class="alert alert-error">載入資料失敗: ${error.message}</div>`;
        }
    }
}

// --- 事件處理中心 (Central Handler) ---

function handleContactListClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    const action = btn.dataset.action;
    const payload = btn.dataset;

    switch (action) {
        case 'view-card':
            // 呼叫外部全域函式 (假設存在於 main.js 或 utils.js)
            if (window.showBusinessCardPreview) {
                window.showBusinessCardPreview(payload.link);
            } else {
                console.warn('showBusinessCardPreview function not found');
            }
            break;
            
        case 'upgrade':
            // [World Model] Upgrade Trigger
            // This initiates the "RAW -> CORE" handoff.
            // Payload contains RAW data (including rowIndex) to seed the new Opportunity/Contact.
            // No direct SQL write happens here; it's delegated to the Wizard/Workflow.
            if (window.NewOppWizard && typeof window.NewOppWizard.startWithContact === 'function') {
                try {
                    const contact = JSON.parse(payload.contact);
                    window.NewOppWizard.startWithContact(contact);
                } catch (err) {
                    console.error('解析聯絡人資料失敗', err);
                }
            } else {
                console.warn('NewOppWizard not found');
            }
            break;
    }
}

function searchContactsEvent(event) {
    const query = event.target.value;
    handleSearch(() => filterAndRenderContacts(query));
}

function filterAndRenderContacts(query = '') {
    const listContent = document.getElementById('contacts-page-content');
    if (!listContent) return;

    let filteredData = [...allContactsData];
    const searchTerm = query.toLowerCase();

    if (searchTerm) {
        filteredData = filteredData.filter(c =>
            (c.name && c.name.toLowerCase().includes(searchTerm)) ||
            (c.company && c.company.toLowerCase().includes(searchTerm))
        );
    }
    
    listContent.innerHTML = renderContactsTable(filteredData);
}

// ==================== 圖表渲染函式 ====================

function renderContactsDashboard(chartData) {
    const container = document.getElementById('contacts-dashboard-container');
    if (!container) return;
    
    container.innerHTML = `
        <div class="dashboard-widget grid-col-12">
            <div class="widget-header"><h2 class="widget-title">潛在客戶增加趨勢 (近30天)</h2></div>
            <div id="contacts-trend-chart" class="widget-content" style="height: 300px;"></div>
        </div>
    `;
    setTimeout(() => {
        renderContactsTrendChart(chartData.trend);
    }, 0);
}

function renderContactsTrendChart(data) {
    if (!data || !Array.isArray(data)) {
        const container = document.getElementById('contacts-trend-chart');
        if (container) container.innerHTML = '<div class="alert alert-warning" style="text-align: center; padding: 10px;">無趨勢資料</div>';
        return;
    }

    const specificOptions = {
        chart: { type: 'area' },
        title: { text: '' },
        xAxis: { categories: data.map(d => d[0] ? d[0].substring(5) : '') },
        yAxis: { title: { text: '數量' } },
        legend: { enabled: false },
        plotOptions: {
            area: {
                fillColor: { linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 }, stops: [] },
                marker: { radius: 2 },
                lineWidth: 2,
                states: { hover: { lineWidth: 3 } },
                threshold: null
            }
        },
        series: [{ name: '新增客戶數', data: data.map(d => d[1] || 0) }]
    };

    if (typeof createThemedChart === 'function') {
        createThemedChart('contacts-trend-chart', specificOptions);
    }
}

// ==================== 專用渲染函式 (重構為卡片) ====================

function renderContactsTable(data) {
    if (!data || data.length === 0) {
        return '<div class="alert alert-info" style="text-align:center; margin-top: 20px;">沒有找到聯絡人資料</div>';
    }

    let listHTML = `<div class="contact-card-list">`;
    data.forEach(contact => {
        const isUpgraded = contact.status === '已升級';
        const isArchived = contact.status === '已歸檔';
        const isFiled = contact.status === '已建檔';
        const isPending = !isUpgraded && !isArchived && !isFiled;

        // 安全序列化
        const contactJsonString = JSON.stringify(contact).replace(/'/g, "&apos;").replace(/"/g, '&quot;');
        const safeDriveLink = contact.driveLink ? contact.driveLink.replace(/'/g, "\\'") : '';

        // 改用 data-action
        const driveLinkBtn = contact.driveLink
            ? `<button class="action-btn small info" title="預覽名片" data-action="view-card" data-link="${safeDriveLink}">💳 名片</button>`
            : '';

        // 改用 data-action
        const upgradeBtn = isPending
            ? `<button class="action-btn small primary" data-action="upgrade" data-contact='${contactJsonString}'>📈 升級</button>`
            : '';

        let statusBadge = '';
        if (isUpgraded) {
            statusBadge = `<span class="contact-card-status upgraded">已升級</span>`;
        } else if (isArchived) {
            statusBadge = `<span class="contact-card-status archived">已歸檔</span>`;
        } else if (isFiled) {
            statusBadge = `<span class="contact-card-status filed">已建檔</span>`;
        } else { 
            statusBadge = `<span class="contact-card-status pending">待處理</span>`;
        }

        listHTML += `
            <div class="contact-card">
                <div class="contact-card-main">
                    <div class="contact-card-header">
                        <span class="contact-card-name">${contact.name || '(無姓名)'}</span>
                        ${statusBadge}
                    </div>
                    <div class="contact-card-company">${contact.company || '(無公司)'}</div>
                    <div class="contact-card-position">${contact.position || '(無職位)'}</div>
                </div>
                <div class="contact-card-actions">
                    ${driveLinkBtn}
                    ${upgradeBtn}
                </div>
            </div>
        `;
    });
    listHTML += '</div>';
    return listHTML;
}

if (window.CRM_APP) {
    if (!window.CRM_APP.pageModules) window.CRM_APP.pageModules = {};
    window.CRM_APP.pageModules.contacts = loadContacts;
}