/**
 * services/company-service.js
 * 公司業務邏輯層
 * * @version 7.8.0 (Phase 7: SQL Write Authority)
 * @date 2026-02-05
 * * @description
 * * 1. [Phase 7] Write Authority Migration: SQL is now the Primary Write Source.
 * * 2. [Refactor] ID Generation moved to Service (COM format).
 * * 3. [Refactor] Update/Delete uses companyId instead of rowIndex.
 * * 4. [Strict] Removed _findCompanyRowIndex dependency for Writes.
 */

class CompanyService {
    constructor(
        companyReader, companyWriter, contactReader, contactWriter,
        opportunityReader, opportunityWriter, interactionReader, interactionWriter,
        eventLogReader, systemReader, companySqlReader, contactService,
        companySqlWriter // Inject SQL Writer
    ) {
        this.companyReader = companyReader;
        this.companyWriter = companyWriter; // Keep for legacy reference if needed, but unused for writes
        this.contactReader = contactReader;
        this.contactWriter = contactWriter;
        this.opportunityReader = opportunityReader;
        this.opportunityWriter = opportunityWriter;
        this.interactionReader = interactionReader;
        this.interactionWriter = interactionWriter;
        this.eventLogReader = eventLogReader;
        this.systemReader = systemReader;
        this.companySqlReader = companySqlReader;
        this.contactService = contactService;
        this.companySqlWriter = companySqlWriter; // Assign
    }

    // --- DTO Mapping (SQL-ready) ---

    /**
     * 將原始資料 (Sheet/SQL) 轉換為 Service 標準 DTO
     * @param {Object} raw 原始資料列
     * @returns {Object} 符合前端合約的 DTO
     */
    _toServiceDTO(raw) {
        if (!raw) return null;

        return {
            // Identity
            companyId: raw.companyId || raw.company_id || '',
            companyName: raw.companyName || raw.company_name || '',
            
            // Contact & Location
            phone: raw.phone || '',
            address: raw.address || '',
            county: raw.county || raw.city || '', // SQL use 'city'
            
            // Business Info
            introduction: raw.introduction || raw.description || '', // SQL use 'description'
            companyType: raw.companyType || raw.company_type || '',
            customerStage: raw.customerStage || raw.customer_stage || '',
            engagementRating: raw.engagementRating || raw.interactionRating || '', // SQL use 'interactionRating'
            
            // Audit
            createdTime: raw.createdTime || raw.created_time || '',
            lastUpdateTime: raw.lastUpdateTime || raw.updatedTime || raw.updated_time || '',
            creator: raw.creator || raw.createdBy || raw.created_by || '',
            lastModifier: raw.lastModifier || raw.updatedBy || raw.updated_by || '',

            // System (Sheet Write legacy, SQL will be undefined)
            rowIndex: raw.rowIndex
        };
    }

    // --- Internal Data Fetching Methods ---

    /**
     * 取得所有公司 (已轉 DTO)
     * 策略: SQL First -> Sheet Fallback
     */
    async _getAllCompanies() {
        let companies = null;

        // 1. Try SQL
        if (this.companySqlReader) {
            try {
                const sqlRaw = await this.companySqlReader.getCompanies();
                if (sqlRaw && Array.isArray(sqlRaw) && sqlRaw.length > 0) {
                    // console.log('[CompanyService] Read Source: SQL');
                    companies = sqlRaw.map(item => this._toServiceDTO(item));
                }
            } catch (error) {
                console.warn(`[CompanyService] SQL Read Failed, falling back: ${error.message}`);
            }
        }

        // 2. Fallback to Sheet
        if (!companies) {
            console.log('[CompanyService] Read Source: Sheet (Fallback)');
            try {
                const sheetRaw = await this.companyReader.getCompanyList();
                companies = sheetRaw.map(item => this._toServiceDTO(item));
            } catch (sheetError) {
                console.error('[CompanyService] Sheet Read Failed:', sheetError);
                throw sheetError;
            }
        }

        return companies;
    }

    /**
     * 依名稱取得單一公司 (已轉 DTO)
     */
    async _getCompanyByName(companyName) {
        if (!companyName) return null;
        
        const companies = await this._getAllCompanies();
        const normalizedTarget = this._normalizeCompanyName(companyName);
        
        return companies.find(c => 
            this._normalizeCompanyName(c.companyName) === normalizedTarget
        ) || null;
    }

    // --- Helpers ---

    _normalizeCompanyName(name) {
        if (!name) return '';
        return name.toLowerCase().trim()
            .replace(/股份有限公司|有限公司|公司/g, '')
            .replace(/\(.*\)/g, '')
            .trim();
    }

    async _logCompanyInteraction(companyId, title, summary, modifier) {
        try {
            if (this.interactionWriter && this.interactionWriter.createInteraction) {
                // Interaction write logic might still be on Sheet or migrating separately
                // Ensure interactionWriter is capable
                await this.interactionWriter.createInteraction({
                    companyId: companyId,
                    eventType: '系統事件',
                    eventTitle: title,
                    contentSummary: summary,
                    recorder: modifier,
                    interactionTime: new Date().toISOString()
                });
            }
        } catch (logError) {
            console.warn(`[CompanyService] Log Interaction Error: ${logError.message}`);
        }
    }

    // --- Public Methods ---

    // 1. 建立公司
    async createCompany(companyName, companyData, user) {
        try {
            const modifier = user.displayName || user.username || user || 'System';
            
            // 檢查重複
            const existing = await this._getCompanyByName(companyName);
            if (existing) {
                return { 
                    success: true, 
                    id: existing.companyId, 
                    name: existing.companyName, 
                    message: '公司已存在', 
                    existed: true,
                    data: existing
                };
            }

            // [Phase 7] Explicit ID Generation in Service
            // Format: COMP_timestamp_random (Legacy Compatible)
            const companyId = `COMP_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

            // 準備資料 (Include generated ID)
            const dataToWrite = { 
                companyId: companyId,
                companyName: companyName, 
                ...companyData 
            };
            
            // 執行寫入 (SQL)
            // Note: companySqlWriter must be injected
            if (!this.companySqlWriter) throw new Error('CompanySqlWriter not injected');
            
            const result = await this.companySqlWriter.createCompany(dataToWrite, modifier);
            
            // 清除快取 (Read might be cached)
            if (this.companyReader.invalidateCache) {
                this.companyReader.invalidateCache('companyList');
            }
            
            return result;
        } catch (error) {
            console.error('[CompanyService] Create Error:', error);
            throw error;
        }
    }

    // 2. 取得列表
    async getCompanyListWithActivity(filters = {}) {
        // ... (Logic unchanged, relies on _getAllCompanies)
        try {
            let companies = await this._getAllCompanies();

            // --- Step 1: 記憶體過濾 ---
            if (filters.q) {
                const q = filters.q.toLowerCase().trim();
                companies = companies.filter(c => 
                    (c.companyName || '').toLowerCase().includes(q) ||
                    (c.phone || '').includes(q) ||
                    (c.address || '').toLowerCase().includes(q) ||
                    (c.county || '').toLowerCase().includes(q) ||
                    (c.introduction || '').toLowerCase().includes(q)
                );
            }

            if (filters.type && filters.type !== 'all') {
                companies = companies.filter(c => c.companyType === filters.type);
            }
            if (filters.stage && filters.stage !== 'all') {
                companies = companies.filter(c => c.customerStage === filters.stage);
            }
            if (filters.rating && filters.rating !== 'all') {
                companies = companies.filter(c => c.engagementRating === filters.rating);
            }

            // --- Step 2: 計算最後活動時間 ---
            const [interactions, eventLogs] = await Promise.all([
                this.interactionReader.getInteractions(),
                this.eventLogReader.getEventLogs()
            ]);

            const lastActivityMap = new Map();
            
            const updateActivity = (companyId, dateStr) => {
                if (!companyId || !dateStr) return;
                const ts = new Date(dateStr).getTime();
                if (isNaN(ts)) return;
                const current = lastActivityMap.get(companyId) || 0;
                if (ts > current) lastActivityMap.set(companyId, ts);
            };

            interactions.forEach(item => updateActivity(item.companyId, item.interactionTime || item.date));
            eventLogs.forEach(item => updateActivity(item.companyId, item.createdTime));

            // --- Step 3: 組合與排序 ---
            const result = companies.map(comp => {
                let lastTs = lastActivityMap.get(comp.companyId);
                
                if (!lastTs && comp.createdTime) {
                    const createdTs = new Date(comp.createdTime).getTime();
                    if (!isNaN(createdTs)) lastTs = createdTs;
                }

                return {
                    ...comp,
                    lastActivity: lastTs ? new Date(lastTs).toISOString() : null,
                    _sortTs: lastTs || 0
                };
            });

            result.sort((a, b) => b._sortTs - a._sortTs);
            return result.map(({ _sortTs, ...rest }) => rest);

        } catch (error) {
            console.error('[CompanyService] List Error:', error);
            // Fallback
            try {
                const sheetRaw = await this.companyReader.getCompanyList();
                return sheetRaw.map(item => this._toServiceDTO(item));
            } catch (fallbackError) {
                return [];
            }
        }
    }

    // 3. 取得詳細資料
    async getCompanyDetails(companyName) {
        // ... (Logic unchanged)
        try {
            const [allCompanies, allContacts, allOpportunities, allInteractions, allEventLogs, allPotentialContacts] = await Promise.all([
                this._getAllCompanies(),
                this.contactReader.getContactList(),
                this.opportunityReader.getOpportunities(),
                this.interactionReader.getInteractions(),
                this.eventLogReader.getEventLogs(),
                this.contactReader.getContacts(3000)
            ]);

            const normalizedTarget = this._normalizeCompanyName(companyName);
            const companyInfo = allCompanies.find(c => this._normalizeCompanyName(c.companyName) === normalizedTarget);

            if (!companyInfo) {
                return { 
                    companyInfo: null, 
                    contacts: [], 
                    opportunities: [], 
                    potentialContacts: [],
                    interactions: [], 
                    eventLogs: [] 
                };
            }

            const companyId = companyInfo.companyId;

            const contacts = allContacts.filter(c => c.companyId === companyId);
            const opportunities = allOpportunities.filter(o => 
                this._normalizeCompanyName(o.customerCompany) === normalizedTarget
            );
            const relatedOppIds = new Set(opportunities.map(o => o.opportunityId));
            
            const interactions = allInteractions.filter(i => 
                i.companyId === companyId || (i.opportunityId && relatedOppIds.has(i.opportunityId))
            ).sort((a, b) => new Date(b.interactionTime || 0) - new Date(a.interactionTime || 0));

            const eventLogs = allEventLogs.filter(e => 
                e.companyId === companyId || (e.opportunityId && relatedOppIds.has(e.opportunityId))
            ).sort((a, b) => new Date(b.createdTime || 0) - new Date(a.createdTime || 0));

            const potentialContacts = allPotentialContacts.filter(pc => 
                this._normalizeCompanyName(pc.company) === normalizedTarget
            );

            return { companyInfo, contacts, opportunities, potentialContacts, interactions, eventLogs };

        } catch (error) {
            console.error(`[CompanyService] Details Error (${companyName}):`, error);
            throw error;
        }
    }

    // 4. 更新公司
    async updateCompany(companyName, updateData, user) {
        try {
            const modifier = user.displayName || user.username || 'System';
            
            // 檢查公司是否存在 & 取得 ID
            const companyInfo = await this._getCompanyByName(companyName);
            if (!companyInfo) throw new Error(`找不到公司: ${companyName}`);
            if (!companyInfo.companyId) throw new Error(`公司資料異常: 無 companyId (${companyName})`);

            // [Phase 7] SQL Update (by companyId)
            // No longer uses _findCompanyRowIndex
            const result = await this.companySqlWriter.updateCompany(companyInfo.companyId, updateData, modifier);
            
            // 紀錄 Log
            await this._logCompanyInteraction(companyInfo.companyId, '資料更新', `公司資料已更新。`, modifier);
            
            // 清除快取
            if (this.companyReader.invalidateCache) {
                this.companyReader.invalidateCache('companyList');
            }

            return result;
        } catch (error) {
            console.error('[CompanyService] Update Error:', error);
            throw error;
        }
    }

    // 5. 刪除公司
    async deleteCompany(companyName, user) {
        try {
            // 取得 ID
            const companyInfo = await this._getCompanyByName(companyName);
            if (!companyInfo) throw new Error(`找不到公司: ${companyName}`);

            // 檢查關聯商機
            const opps = await this.opportunityReader.getOpportunities();
            const relatedOpps = opps.filter(o => 
                this._normalizeCompanyName(o.customerCompany) === this._normalizeCompanyName(companyName)
            );
            
            if (relatedOpps.length > 0) {
                throw new Error(`無法刪除：尚有 ${relatedOpps.length} 個關聯機會案件 (例如: ${relatedOpps[0].opportunityName})。請先移除關聯案件。`);
            }

            // [Phase 7] SQL Delete (by companyId)
            const result = await this.companySqlWriter.deleteCompany(companyInfo.companyId);
            
            // 清除快取
            if (this.companyReader.invalidateCache) {
                this.companyReader.invalidateCache('companyList');
            }

            return result;
        } catch (error) {
            console.error('[CompanyService] Delete Error:', error);
            throw error;
        }
    }
}

module.exports = CompanyService;