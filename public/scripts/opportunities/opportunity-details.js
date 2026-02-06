// public/scripts/opportunities/opportunity-details.js
// [FINAL FIX] Phase 7 - Controller Flow + Event Binding Alignment
// 重點：
// 1. 維持 dashboard-widget / widget-content 視覺殼
// 2. View 仍為 pure function（只回傳 HTML）
// 3. 明確將「實際 DOM root」傳給 Events.init，修復編輯無法點擊問題

window.currentDetailOpportunityId = null;
window.currentOpportunityData = null; 

/**
 * 載入並渲染機會詳細頁面的主函式
 * @param {string} opportunityId - 機會ID
 */
async function loadOpportunityDetailPage(opportunityId) {
    window.currentDetailOpportunityId = opportunityId;
    
    const container = document.getElementById('page-opportunity-details');
    if (!container) return;

    container.innerHTML = `
        <div class="loading show" style="padding-top: 50px;">
            <div class="spinner"></div>
            <p>正在載入機會詳細資料...</p>
        </div>
    `;

    try {
        const opportunityDetailPageTemplate = await fetch('/views/opportunity-detail.html').then(res => res.text());
        const result = await authedFetch(`/api/opportunities/${opportunityId}/details`);
        if (!result.success) throw new Error(result.error);
        
        const {
            opportunityInfo,
            interactions,
            eventLogs,
            linkedContacts,
            potentialContacts,
            parentOpportunity,
            childOpportunities
        } = result.data;

        window.currentOpportunityData = opportunityInfo; 

        // 1. 注入主模板
        container.innerHTML = opportunityDetailPageTemplate;
        document.getElementById('page-title').textContent = '機會案件管理 - 機會詳細';
        document.getElementById('page-subtitle').textContent = '機會詳細資料與關聯活動';

        // 2. 注入資訊卡（含舊版視覺殼）
        const infoCardContainer = document.getElementById('opportunity-info-card-container');
        let infoCardRoot = null;

        if (infoCardContainer && typeof OpportunityInfoView !== 'undefined') {
            infoCardContainer.innerHTML = `
                <div class="dashboard-widget">
                    <div class="widget-content">
                        ${OpportunityInfoView.render(opportunityInfo)}
                    </div>
                </div>
            `;
            // ★ 關鍵：實際可綁事件的 root
            infoCardRoot = infoCardContainer.querySelector('.widget-content');
        }

        // 3. 初始化資訊卡事件（明確傳入 root，避免 selector 失效）
        if (infoCardRoot && typeof OpportunityInfoCardEvents !== 'undefined') {
            OpportunityInfoCardEvents.init(opportunityInfo, infoCardRoot);
        }

        // 4. 其他模組初始化（順序不變）
        OpportunityStepper.init(opportunityInfo);
        
        OpportunityEvents.init(eventLogs || [], {
            opportunityId: opportunityInfo.opportunityId,
            opportunityName: opportunityInfo.opportunityName,
            linkedContacts: linkedContacts || []
        });

        const interactionContainer = document.getElementById('tab-content-interactions');
        if (interactionContainer) {
            OpportunityInteractions.init(
                interactionContainer,
                { opportunityId: opportunityInfo.opportunityId },
                interactions || []
            );
        }

        OpportunityContacts.init(opportunityInfo, linkedContacts || []);
        OpportunityAssociatedOpps.render({
            opportunityInfo,
            parentOpportunity,
            childOpportunities
        });

        if (window.PotentialContactsManager) {
            PotentialContactsManager.render({
                containerSelector: '#opp-potential-contacts-container',
                potentialContacts: potentialContacts || [],
                comparisonList: linkedContacts || [],
                comparisonKey: 'name',
                context: 'opportunity',
                opportunityId: opportunityInfo.opportunityId
            });
        }

        CRM_APP.updateAllDropdowns();

    } catch (error) {
        if (error.message !== 'Unauthorized') {
            console.error('[OpportunityDetails] 載入失敗:', error);
            container.innerHTML = `
                <div class="alert alert-error">
                    載入機會詳細資料失敗: ${error.message}
                </div>
            `;
        }
    }
}

// 註冊模組
if (window.CRM_APP) {
    window.CRM_APP.pageModules['opportunity-details'] = loadOpportunityDetailPage;
}
