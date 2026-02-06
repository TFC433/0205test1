/**
 * services/opportunity-service.js
 * 機會案件業務邏輯層 (Service Layer)
 * * @version 8.2.0 (Phase 7: Contact Linking SQL)
 * @date 2026-02-06
 * @description 
 * - [FIX-1] Locked _fetchOpportunities to SQL Reader only (No Sheet fallback).
 * - [FIX-2] Enforced hard contract on batchUpdateOpportunities (Throw on missing ID).
 * - [FIX-3] Explicitly marked RAW Contact Upgrade boundary.
 * - [PHASE 7] Migrated Contact Linking (Add/Delete) to SQL Writer.
 */

class OpportunityService {
    /**
     * @param {Object} config - 系統設定
     * @param {OpportunityReader} opportunityReader
     * @param {OpportunityWriter} opportunityWriter
     * @param {ContactReader} contactReader
     * @param {ContactWriter} contactWriter
     * @param {CompanyReader} companyReader
     * @param {CompanyWriter} companyWriter
     * @param {InteractionReader} interactionReader
     * @param {InteractionWriter} interactionWriter
     * @param {EventLogReader} eventLogReader
     * @param {SystemReader} systemReader
     * @param {OpportunitySqlReader} opportunitySqlReader
     * @param {OpportunitySqlWriter} opportunitySqlWriter
     */
    constructor({
        config,
        opportunityReader,
        opportunityWriter,
        contactReader,
        contactWriter,
        companyReader,
        companyWriter,
        interactionReader,
        interactionWriter,
        eventLogReader,
        systemReader,
        opportunitySqlReader,
        opportunitySqlWriter
    }) {
        this.config = config;
        
        // Readers
        this.opportunityReader = opportunityReader;
        this.interactionReader = interactionReader;
        this.eventLogReader = eventLogReader;
        this.contactReader = contactReader;
        this.systemReader = systemReader;
        this.companyReader = companyReader;
        this.opportunitySqlReader = opportunitySqlReader;

        // Writers
        this.opportunityWriter = opportunityWriter;
        this.contactWriter = contactWriter;
        this.companyWriter = companyWriter;
        this.interactionWriter = interactionWriter;
        this.opportunitySqlWriter = opportunitySqlWriter;
    }

    /**
     * 標準化公司名稱的輔助函式
     */
    _normalizeCompanyName(name) {
        if (!name) return '';
        return name
            .toLowerCase()
            .trim()
            .replace(/股份有限公司|有限公司|公司/g, '')
            .replace(/\(.*\)/g, '')
            .trim();
    }

    /**
     * [Phase 7 Boundary Fix v1] 統一資料獲取入口 - SQL ONLY
     * [FIX-1] Lock Read World to SQL ONLY
     */
    async _fetchOpportunities() {
        // Strict enforcement: OpportunitySqlReader is required.
        // No fallback to Sheet Reader is allowed in CORE logic.
        if (!this.opportunitySqlReader) {
            throw new Error("[Phase7 Boundary Violation] OpportunitySqlReader is required");
        }
        
        return await this.opportunitySqlReader.getOpportunities();
    }

    /**
     * 輔助函式：建立一筆機會互動日誌
     */
    async _logOpportunityInteraction(opportunityId, title, summary, modifier) {
        try {
            await this.interactionWriter.createInteraction({
                opportunityId: opportunityId,
                eventType: '系統事件',
                eventTitle: title,
                contentSummary: summary,
                recorder: modifier,
                interactionTime: new Date().toISOString()
            });
        } catch (logError) {
            console.warn(`[OpportunityService] 寫入機會日誌失敗 (OppID: ${opportunityId}): ${logError.message}`);
        }
    }

    /**
     * 建立新機會案件
     */
    async createOpportunity(opportunityData, user) {
        try {
            const modifier = user.displayName || user.username || 'System';
            const result = await this.opportunitySqlWriter.createOpportunity(opportunityData, modifier);
            
            return result;
        } catch (error) {
            console.error('[OpportunityService] createOpportunity Error:', error);
            throw error;
        }
    }

    /**
     * 高效獲取機會案件的完整詳細資料
     */
    async getOpportunityDetails(opportunityId) {
        try {
            const [
                allOpportunities, 
                interactionsFromCache, 
                eventLogsFromCache, 
                allLinks,
                allOfficialContacts,
                allPotentialContacts
            ] = await Promise.all([
                this._fetchOpportunities(),
                this.interactionReader.getInteractions(),
                this.eventLogReader.getEventLogs(),
                this.contactReader.getAllOppContactLinks(),
                this.contactReader.getContactList(),
                this.contactReader.getContacts()
            ]);
            
            const opportunityInfo = allOpportunities.find(opp => opp.opportunityId === opportunityId);
            if (!opportunityInfo) {
                throw new Error(`找不到機會ID為 ${opportunityId} 的案件`);
            }

            const safeGet = (obj, keys) => {
                for (const k of keys) {
                    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
                }
                return undefined;
            };

            const normalizeStr = (v) => (v === undefined || v === null) ? '' : String(v).trim();

            const linkedContactsFromCache = (allLinks || [])
                .filter(link => {
                    const linkOppId = normalizeStr(safeGet(link, ['opportunityId', 'oppId', 'opportunity_id']));
                    if (!linkOppId) return false;

                    const statusVal = normalizeStr(safeGet(link, ['status', 'linkStatus', 'state'])).toLowerCase();
                    const isActive = !statusVal || statusVal === 'active';

                    return linkOppId === normalizeStr(opportunityId) && isActive;
                })
                .map(link => {
                    const linkContactId = normalizeStr(safeGet(link, ['contactId', 'id', 'contact_id']));
                    if (!linkContactId) return null;

                    const contact = (allOfficialContacts || []).find(c => normalizeStr(c.contactId) === linkContactId);
                    if (!contact) return null;

                    const linkId = safeGet(link, ['linkId', 'id', 'rowId', 'rowIndex']);
                    return { ...contact, linkId: linkId };
                })
                .filter(Boolean);
            
            const interactions = interactionsFromCache
                .filter(i => i.opportunityId === opportunityId)
                .sort((a, b) => new Date(b.interactionTime || b.createdTime) - new Date(a.interactionTime || a.createdTime));

            const eventLogs = eventLogsFromCache
                .filter(log => log.opportunityId === opportunityId)
                .sort((a, b) => new Date(b.createdTime || 0) - new Date(a.createdTime || 0));

            const normalizedOppCompany = this._normalizeCompanyName(opportunityInfo.customerCompany);
            
            const potentialContacts = allPotentialContacts.filter(pc => {
                const normalizedPcCompany = this._normalizeCompanyName(pc.company);
                return normalizedPcCompany && normalizedOppCompany && normalizedPcCompany === normalizedOppCompany;
            });

            let mainContactJobTitle = '';
            const targetName = (opportunityInfo.mainContact || '').trim();
            
            if (targetName) {
                const linkedMatch = linkedContactsFromCache.find(c => c.name === targetName);
                if (linkedMatch && linkedMatch.position) {
                    mainContactJobTitle = linkedMatch.position;
                } 
                else {
                    const potentialMatch = potentialContacts.find(pc => pc.name === targetName); 
                    if (potentialMatch && potentialMatch.position) {
                        mainContactJobTitle = potentialMatch.position;
                    } else {
                        const fallbackMatch = allPotentialContacts.find(pc => 
                            pc.name === targetName && 
                            this._normalizeCompanyName(pc.company) === normalizedOppCompany
                        );
                        if (fallbackMatch && fallbackMatch.position) {
                            mainContactJobTitle = fallbackMatch.position;
                        }
                    }
                }
            }
            opportunityInfo.mainContactJobTitle = mainContactJobTitle;

            let parentOpportunity = null;
            if (opportunityInfo.parentOpportunityId) {
                parentOpportunity = allOpportunities.find(opp => opp.opportunityId === opportunityInfo.parentOpportunityId) || null;
            }
            const childOpportunities = allOpportunities.filter(opp => opp.parentOpportunityId === opportunityId);

            return {
                opportunityInfo,
                interactions,
                eventLogs,
                linkedContacts: linkedContactsFromCache,
                potentialContacts,
                parentOpportunity,
                childOpportunities
            };
        } catch (error) {
            console.error(`[OpportunityService] getOpportunityDetails Error (${opportunityId}):`, error);
            throw error;
        }
    }

    /**
     * 更新機會案件，並自動新增多種互動紀錄
     */
    async updateOpportunity(opportunityId, updateData, user) {
        try {
            const modifier = user.displayName || user.username || 'System';
            
            const originalOpportunity = await this.opportunitySqlReader.getOpportunityById(opportunityId);
            
            if (!originalOpportunity) {
                throw new Error(`找不到要更新的機會 (ID: ${opportunityId})`);
            }
            
            const oldStage = originalOpportunity.currentStage;

            const systemConfig = await this.systemReader.getSystemConfig();
            const getNote = (configKey, value) => (systemConfig[configKey] || []).find(i => i.value === value)?.note || value || 'N/A';
            const stageMapping = new Map((systemConfig['機會階段'] || []).map(item => [item.value, item.note]));
            
            const logs = [];

            const newStage = updateData.currentStage;
            if (newStage && oldStage && newStage !== oldStage) {
                const oldStageName = stageMapping.get(oldStage) || oldStage;
                const newStageName = stageMapping.get(newStage) || newStage;
                logs.push(`階段從【${oldStageName}】更新為【${newStageName}】`);
            }
            
            if (updateData.opportunityValue !== undefined && updateData.opportunityValue !== originalOpportunity.opportunityValue) {
                logs.push(`機會價值從 [${originalOpportunity.opportunityValue || '未設定'}] 更新為 [${updateData.opportunityValue || '未設定'}]`);
            }

            const oldAssignee = originalOpportunity.assignee || originalOpportunity.owner;
            if (updateData.assignee !== undefined && updateData.assignee !== oldAssignee) {
                logs.push(`負責業務從 [${getNote('團隊成員', oldAssignee)}] 變更為 [${getNote('團隊成員', updateData.assignee)}]`);
            }
            
            if (updateData.expectedCloseDate !== undefined && updateData.expectedCloseDate !== originalOpportunity.expectedCloseDate) {
                logs.push(`預計結案日從 [${originalOpportunity.expectedCloseDate || '未設定'}] 更新為 [${updateData.expectedCloseDate || '未設定'}]`);
            }

            const updateResult = await this.opportunitySqlWriter.updateOpportunity(opportunityId, updateData, modifier);
            
            if (logs.length > 0) {
                await this._logOpportunityInteraction(
                    opportunityId,
                    '機會資料更新',
                    logs.join('； '),
                    modifier
                );
            }
            
            return updateResult;
        } catch (error) {
            console.error('[OpportunityService] updateOpportunity Error:', error);
            throw error;
        }
    }
    
    /**
     * 將一個聯絡人關聯到機會案件的工作流
     */
    async addContactToOpportunity(opportunityId, contactData, user) {
        try {
            const modifier = user.displayName || user.username || 'System';
            let contactToLink;
            let logTitle = '關聯聯絡人';

            if (contactData.contactId) {
                contactToLink = { id: contactData.contactId, name: contactData.name };
            } 
            else {
                if (!contactData.company) throw new Error("無法關聯聯絡人：缺少公司名稱。");
                
                logTitle = '建立並關聯新聯絡人';
                const contactCompanyData = await this.companyWriter.getOrCreateCompany(contactData.company, contactData, modifier, {});
                contactToLink = await this.contactWriter.getOrCreateContact(contactData, contactCompanyData, modifier);

                // ================================
                // RAW CONTACT UPGRADE ZONE
                // Scope: IDS.RAW ONLY (Contact Module)
                // rowIndex usage is ALLOWED here (Contact is not Phase 7)
                // ================================
                if (contactData.rowIndex) {
                    logTitle = '從潛在客戶關聯';
                    await this.contactWriter.updateContactStatus(
                        contactData.rowIndex,
                        this.config.CONSTANTS.CONTACT_STATUS.UPGRADED
                    );
                }
            }

            // [Phase 7 Migration] SQL Write Authority
            // Old: await this.opportunityWriter.linkContactToOpportunity(opportunityId, contactToLink.id, modifier);
            const linkResult = await this.opportunitySqlWriter.linkContact(opportunityId, contactToLink.id, modifier);
            
            await this._logOpportunityInteraction(
                opportunityId,
                logTitle,
                `將聯絡人 "${contactToLink.name}" 關聯至此機會。`,
                modifier
            );

            return { success: true, message: '聯絡人關聯成功', data: { contact: contactToLink, link: linkResult } };
        } catch (error) {
            console.error('[OpportunityService] addContactToOpportunity Error:', error);
            throw error;
        }
    }

    /**
     * 刪除機會與聯絡人的關聯
     */
    async deleteContactLink(opportunityId, contactId, user) {
        try {
            const modifier = user.displayName || user.username || 'System';
            
            const allContacts = await this.contactReader.getContactList();
            const contact = allContacts.find(c => c.contactId === contactId);
            const contactName = contact ? contact.name : `ID ${contactId}`;

            // [Phase 7 Migration] SQL Write Authority
            // Old: await this.opportunityWriter.deleteContactLink(opportunityId, contactId);
            const deleteResult = await this.opportunitySqlWriter.unlinkContact(opportunityId, contactId);

            if (deleteResult.success) {
                await this._logOpportunityInteraction(
                    opportunityId,
                    '解除聯絡人關聯',
                    `將聯絡人 "${contactName}" 從此機會移除。`,
                    modifier
                );
            }

            return deleteResult;
        } catch (error) {
            console.error('[OpportunityService] deleteContactLink Error:', error);
            throw error;
        }
    }

    /**
     * 刪除一筆機會案件
     */
    async deleteOpportunity(opportunityId, user) {
        try {
            const modifier = user.displayName || user.username || 'System';
            
            const opportunity = await this.opportunitySqlReader.getOpportunityById(opportunityId);
            
            if (!opportunity) {
                throw new Error(`找不到要刪除的機會 (ID: ${opportunityId})`);
            }

            const deleteResult = await this.opportunitySqlWriter.deleteOpportunity(opportunityId, modifier);
            
            if (deleteResult.success && opportunity.customerCompany) {
                try {
                    const allCompanies = await this.companyReader.getCompanyList();
                    const company = allCompanies.find(c => 
                        c.companyName.toLowerCase().trim() === opportunity.customerCompany.toLowerCase().trim()
                    );
                    
                    if (company) {
                        await this.interactionWriter.createInteraction({
                            companyId: company.companyId,
                            eventType: '系統事件',
                            eventTitle: '刪除機會案件',
                            contentSummary: `機會案件 "${opportunity.opportunityName}" (ID: ${opportunity.opportunityId}) 已被 ${modifier} 刪除。`,
                            recorder: modifier,
                            interactionTime: new Date().toISOString()
                        });
                    }
                } catch (logError) {
                     console.warn(`[OpportunityService] 寫入公司日誌失敗 (刪除機會時): ${logError.message}`);
                }
            }
            
            return deleteResult;
        } catch (error) {
            console.error('[OpportunityService] deleteOpportunity Error:', error);
            throw error;
        }
    }

    /**
     * 根據日期範圍獲取機會案件
     */
    async getOpportunitiesByDateRange(startDate, endDate, dateField = 'createdTime') {
        try {
            const allOpportunities = await this._fetchOpportunities();
            
            return allOpportunities.filter(opp => {
                const dateVal = opp[dateField];
                if (!dateVal) return false;
                
                const oppDate = new Date(dateVal);
                if (isNaN(oppDate.getTime())) return false; 

                return oppDate.getTime() >= startDate.getTime() && oppDate.getTime() <= endDate.getTime();
            });
        } catch (error) {
            console.error('[OpportunityService] getOpportunitiesByDateRange Error:', error);
            return [];
        }
    }

    /**
     * [Standard A] 獲取縣市分佈統計
     */
    async getOpportunitiesByCounty(opportunityType = null) {
        try {
            const [allOpportunities, companies] = await Promise.all([
                this._fetchOpportunities(),
                this.companyReader.getCompanyList()
            ]);

            const activeOpportunities = allOpportunities.filter(opp => 
                opp.currentStatus !== this.config.CONSTANTS.OPPORTUNITY_STATUS.ARCHIVED
            );

            let filteredOpportunities = opportunityType
                ? activeOpportunities.filter(opp => opp.opportunityType === opportunityType)
                : activeOpportunities;
            
            const normalize = (name) => name ? name.toLowerCase().trim() : '';
            const companyToCountyMap = new Map();
            
            (companies || []).forEach(c => {
                if (c.companyName) {
                    companyToCountyMap.set(normalize(c.companyName), c.county);
                }
            });

            const countyCounts = {};
            filteredOpportunities.forEach(opp => {
                const county = companyToCountyMap.get(normalize(opp.customerCompany));
                if (county) {
                    countyCounts[county] = (countyCounts[county] || 0) + 1;
                }
            });

            return Object.entries(countyCounts).map(([county, count]) => ({ county, count }));

        } catch (error) {
            console.error('❌ [OpportunityService] getOpportunitiesByCounty 錯誤:', error);
            return [];
        }
    }

    /**
     * [Standard A] 按階段聚合機會案件
     */
    async getOpportunitiesByStage() {
        try {
            const [opportunities, systemConfig] = await Promise.all([
                this._fetchOpportunities(),
                this.systemReader.getSystemConfig()
            ]);
            
            const safeOpportunities = Array.isArray(opportunities) ? opportunities : [];
            const stages = systemConfig['機會階段'] || [];
            const stageGroups = {};

            stages.forEach(stage => {
                stageGroups[stage.value] = { name: stage.note || stage.value, opportunities: [], count: 0 };
            });

            safeOpportunities.forEach(opp => {
                if (opp.currentStatus === '進行中') {
                    const stageKey = opp.currentStage;
                    if (stageGroups[stageKey]) {
                        stageGroups[stageKey].opportunities.push(opp);
                        stageGroups[stageKey].count++;
                    }
                }
            });
            return stageGroups;
        } catch (error) {
            console.error('❌ [OpportunityService] getOpportunitiesByStage 錯誤:', error);
            return {};
        }
    }

    /**
     * [Standard A] 搜尋機會案件
     */
    async searchOpportunities(query, page, filters) {
        try {
            let items = await this._fetchOpportunities();

            if (!filters || !filters.includeArchived) {
                items = items.filter(o => o.currentStatus !== this.config.CONSTANTS.OPPORTUNITY_STATUS.ARCHIVED);
            }

            if (query) {
                const q = query.toLowerCase().trim();
                items = items.filter(o => 
                    (o.opportunityName && o.opportunityName.toLowerCase().includes(q)) ||
                    (o.customerCompany && o.customerCompany.toLowerCase().includes(q))
                );
            }

            if (filters) {
                if (filters.stage && filters.stage !== 'all') {
                    items = items.filter(o => o.currentStage === filters.stage);
                }
                if (filters.assignee && filters.assignee !== 'all') {
                    items = items.filter(o => (o.assignee || o.owner) === filters.assignee);
                }
                if (filters.status && filters.status !== 'all') {
                    items = items.filter(o => o.currentStatus === filters.status);
                }
                if (filters.minProb) {
                    items = items.filter(o => Number(o.probability || o.winProbability || 0) >= Number(filters.minProb));
                }
            }

            items.sort((a, b) => {
                const dateA = new Date(a.lastUpdateTime || a.updatedTime || 0).getTime();
                const dateB = new Date(b.lastUpdateTime || b.updatedTime || 0).getTime();
                return dateB - dateA;
            });

            return items;

        } catch (error) {
             console.error('❌ [OpportunityService] searchOpportunities 錯誤:', error);
             throw error;
        }
    }

    /**
     * 批量更新機會案件
     * [FIX-2] Enforce Hard Contract (Fail Fast on missing ID)
     */
    async batchUpdateOpportunities(updates) {
        let successCount = 0;
        
        for (const update of updates) {
            if (!update.opportunityId) {
                throw new Error("[Phase7 Contract Violation] batchUpdateOpportunities requires opportunityId");
            }

            try {
                await this.updateOpportunity(update.opportunityId, update.data, { displayName: update.modifier });
                successCount++;
            } catch (error) {
                console.error(`[OpportunityService] Batch Update Error (ID: ${update.opportunityId}):`, error);
                throw error;
            }
        }
        return { success: true, successCount };
    }
}

module.exports = OpportunityService;