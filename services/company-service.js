/**
 * services/company-service.js
 * 公司業務邏輯層
 * * @version 7.9.0 (Phase 8: ID-based Operations & SQL Write Authority)
 * @date 2026-02-10
 * * @description
 * * 1. [Phase 8] Contract Enforcement: companyId is the ONLY valid operation key for Update/Delete/Details.
 * * 2. [Phase 8] Refactor: updateCompany, deleteCompany, getCompanyDetails now accept companyId.
 * * 3. [Phase 8] Lookup: Added _getCompanyById helper; removed name-based lookups for mutation operations.
 * * 4. [Phase 7] Write Authority: SQL is the exclusive write source (CompanySqlWriter).
 * * 5. [Phase 7] Legacy Removal: No Sheet write logic, no rowIndex usage for operations.
 */

class CompanyService {
    constructor(
        companyReader, companyWriter, contactReader, contactWriter,
        opportunityReader, opportunityWriter, interactionReader, interactionWriter,
        eventLogReader, systemReader, companySqlReader, contactService,
        companySqlWriter // Inject SQL Writer (Phase 7 Requirement)
    ) {
        this.companyReader = companyReader;
        this.companyWriter = companyWriter; // Keep for legacy read references if needed
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
        this.companySqlWriter = companySqlWriter; // Assigned for Phase 7 Writes
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

            // System (Legacy Sheet artifact, not used for operations)
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

        // 1. Try SQL (Phase 7 Primary Read)
        if (this.companySqlReader) {
            try {
                const sqlRaw = await this.companySqlReader.getCompanies();
                if (sqlRaw && Array.isArray(sqlRaw) && sqlRaw.length > 0) {
                    companies = sqlRaw.map(item => this._toServiceDTO(item));
                }
            } catch (error) {
                console.warn(`[CompanyService] SQL Read Failed, falling back: ${error.message}`);
            }
        }

        // 2. Fallback to Sheet (Legacy Support)
        if (!companies) {
            // console.log('[CompanyService] Read Source: Sheet (Fallback)');
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
     * [Phase 8 Helper] 依 ID 取得單一公司 (已轉 DTO)
     * 這是 Phase 8 所有 mutation 操作的唯一合法查找方式
     * @param {string} companyId 
     * @returns {Promise<Object|null>}
     */
    async _getCompanyById(companyId) {
        if (!companyId) return null;
        const companies = await this._getAllCompanies();
        return companies.find(c => c.companyId === companyId) || null;
    }

    /**
     * 依名稱取得單一公司 (已轉 DTO)
     * 僅用於建立公司時檢查重複 (Business Rule: Unique Name)
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
            
            // 檢查重複 (Business Rule: Name Uniqueness)
            const existing = await this._getCompanyByName(companyName);
            if (existing) {
                return { 
                    success: true, 
                    id: existing.companyId, 
                    companyId: existing.companyId, // Explicit return for Phase 8
                    companyName: existing.companyName, 
                    message: '公司已存在', 
                    existed: true,
                    data: existing
                };
            }

            // [Phase 7] Explicit ID Generation in Service
            // Format: COMP_timestamp_random
            const companyId = `COMP_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

            // 準備資料
            const dataToWrite = { 
                companyId: companyId,
                companyName: companyName, 
                ...companyData 
            };
            
            // 執行寫入 (SQL ONLY - Phase 7)
            if (!this.companySqlWriter) throw new Error('CompanySqlWriter not injected');
            
            const result = await this.companySqlWriter.createCompany(dataToWrite, modifier);
            
            // 清除快取
            if (this.companyReader.invalidateCache) {
                this.companyReader.invalidateCache('companyList');
            }
            
            // Ensure ID is returned
            return {
                ...result,
                companyId: companyId,
                companyName: companyName
            };
        } catch (error) {
            console.error('[CompanyService] Create Error:', error);
            throw error;
        }
    }

    // 2. 取得列表 (Read Only - Name/Text Filter Allowed)
    async getCompanyListWithActivity(filters = {}) {
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
            // Fallback (Legacy)
            try {
                const sheetRaw = await this.companyReader.getCompanyList();
                return sheetRaw.map(item => this._toServiceDTO(item));
            } catch (fallbackError) {
                return [];
            }
        }
    }

    // 3. 取得詳細資料
    // [Phase 8] Argument changed from companyName to companyId
    async getCompanyDetails(companyId) {
        try {
            const [allCompanies, allContacts, allOpportunities, allInteractions, allEventLogs, allPotentialContacts] = await Promise.all([
                this._getAllCompanies(),
                this.contactReader.getContactList(),
                this.opportunityReader.getOpportunities(),
                this.interactionReader.getInteractions(),
                this.eventLogReader.getEventLogs(),
                this.contactReader.getContacts(3000)
            ]);

            // [Phase 8] Lookup by ID
            const companyInfo = allCompanies.find(c => c.companyId === companyId);

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

            // Derive Name for legacy association lookups
            const companyName = companyInfo.companyName;
            const normalizedTarget = this._normalizeCompanyName(companyName);

            // Filter related data
            const contacts = allContacts.filter(c => c.companyId === companyId);
            
            // Opportunities: Fallback to name matching for legacy data support
            const opportunities = allOpportunities.filter(o => 
                this._normalizeCompanyName(o.customerCompany) === normalizedTarget
            );
            const relatedOppIds = new Set(opportunities.map(o => o.opportunityId));
            
            // Interactions & Events: Link by CompanyID or via related OpportunityID
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
            console.error(`[CompanyService] Details Error (${companyId}):`, error);
            throw error;
        }
    }

    // 4. 更新公司
    // [Phase 8] Argument changed from companyName to companyId
    async updateCompany(companyId, updateData, user) {
        try {
            const modifier = user.displayName || user.username || 'System';
            
            // [Phase 8] Strict ID Lookup
            const companyInfo = await this._getCompanyById(companyId);
            if (!companyInfo) throw new Error(`找不到公司 ID: ${companyId}`);

            // [Phase 7] SQL Update (by companyId)
            // SQL Writer handles the actual DB update
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
    // [Phase 8] Argument changed from companyName to companyId
    async deleteCompany(companyId, user) {
        try {
            // [Phase 8] Strict ID Lookup
            const companyInfo = await this._getCompanyById(companyId);
            if (!companyInfo) throw new Error(`找不到公司 ID: ${companyId}`);

            // 檢查關聯商機 (Use name derived from found company to maintain safety for legacy data)
            const companyName = companyInfo.companyName;
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