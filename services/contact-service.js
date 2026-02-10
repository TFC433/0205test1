// services/contact-service.js
/**
 * services/contact-service.js
 * 聯絡人業務邏輯服務層
 * @version 8.0.0 (Phase 8: World Model Annotation)
 * @date 2026-02-10
 * @description
 * [STRICT WRITE AUTHORITY]
 * - CORE CONTACT ZONE (Official): SQL ONLY for Create/Update/Delete. NO Sheet fallback for writes.
 * - RAW CONTACT ZONE (Potential): Sheet ONLY via rowIndex.
 * - READS: Hybrid (SQL Primary -> Sheet Fallback) maintained for backward compatibility.
 * * WORLD MODEL (DATA LAYER):
 * 1. RAW Contact:
 * - Lives in Google Sheets (accessed via contactRawReader).
 * - Read-Only for CRM logic (Upgrade process copies data, doesn't move it).
 * - Update allowed ONLY for status flags (via updatePotentialContact / Sheet Writer).
 * * 2. CORE Contact:
 * - Lives in SQL (accessed via contactSqlReader/Writer).
 * - The ONLY place where Opportunity linkage occurs.
 * - Created via createContact (SQL Writer).
 */

class ContactService {
    /**
     * @param {ContactReader} contactRawReader  - bound to IDS.RAW (Potential contacts)
     * @param {ContactReader} contactCoreReader - bound to IDS.CORE (Official list + link table)
     * @param {ContactWriter} contactWriter     - RAW write only (Sheet)
     * @param {CompanyReader} companyReader
     * @param {Object} config
     * @param {ContactSqlReader} [contactSqlReader]
     * @param {ContactSqlWriter} [contactSqlWriter]
     */
    constructor(contactRawReader, contactCoreReader, contactWriter, companyReader, config, contactSqlReader, contactSqlWriter) {
        this.contactRawReader = contactRawReader;
        this.contactCoreReader = contactCoreReader;
        this.contactWriter = contactWriter;
        this.companyReader = companyReader;
        this.config = config || { PAGINATION: { CONTACTS_PER_PAGE: 20 } };
        this.contactSqlReader = contactSqlReader;
        this.contactSqlWriter = contactSqlWriter;
    }

    // ============================================================
    // INTERNAL HELPERS (READ MAPPING)
    // ============================================================

    _normalizeKey(str = '') {
        return String(str).toLowerCase().trim();
    }

    _mapSqlContact(contact) {
        return {
            ...contact,
            position: contact.jobTitle || contact.position, // Normalize to internal convention
            jobTitle: contact.jobTitle || contact.position
        };
    }

    _mapOfficialContact(contact, companyNameMap) {
        return {
            ...contact,
            companyName: companyNameMap.get(contact.companyId) || contact.companyId
        };
    }

    // ============================================================
    // READ OPERATIONS (HYBRID: SQL PRIMARY -> SHEET FALLBACK)
    // ============================================================

    /**
     * [ZONE: CORE / OFFICIAL]
     * Internal Fetcher with V8-A Allowed Fallback
     * Strategy:
     * 1. Try SQL (Authoritative Source)
     * 2. If SQL fails or returns empty (and we suspect sync lag), fallback to Sheet (Legacy Read).
     * Note: This fallback is strictly for READ availability, never for Writes.
     */
    async _fetchOfficialContactsWithCompanies(forceSheet = false) {
        let allContacts = null;

        // 1) SQL primary
        if (!forceSheet) {
            if (this.contactSqlReader) {
                try {
                    const sqlContacts = await this.contactSqlReader.getContacts();
                    if (!sqlContacts || sqlContacts.length === 0) {
                        // SQL might be empty intentionally, but if we suspect sync lag, we fallback.
                        // For now, if SQL returns empty array, we accept it as empty unless we really want fallback.
                        // Assuming standard behavior: valid empty array is a result. Null/undefined is error.
                        allContacts = sqlContacts.map(c => this._mapSqlContact(c));
                    } else {
                         allContacts = sqlContacts.map(c => this._mapSqlContact(c));
                    }
                } catch (error) {
                    console.warn('[ContactService] SQL Read Error (Fallback to Sheet):', error.message);
                    allContacts = null;
                }
            }
        }

        // 2) Sheet fallback (MUST be CORE reader)
        if (!allContacts) {
            if (!this.contactCoreReader) {
                console.warn('[ContactService] contactCoreReader not configured, returning empty.');
                return [];
            }
            // console.warn('[ContactService] Falling back to Sheet for Official Contacts');
            allContacts = await this.contactCoreReader.getContactList();
        }

        // 3) Join companies
        const allCompanies = await this.companyReader.getCompanyList();
        const companyNameMap = new Map(allCompanies.map(c => [c.companyId, c.companyName]));

        return allContacts.map(contact => this._mapOfficialContact(contact, companyNameMap));
    }

    async _resolveContactRowIndex(contactId) {
        // [Phase 7 Forensics] 
        // This method implies looking up a row index for a CORE contact.
        // Since CORE writes are now SQL-only, this should only be used if absolutely necessary for some legacy read operation.
        // It MUST NOT be used for writes.
        if (!this.contactCoreReader) throw new Error('[ContactService] contactCoreReader not configured');
        const allContacts = await this.contactCoreReader.getContactList();
        const target = allContacts.find(c => c.contactId === contactId);

        if (!target) throw new Error(`Contact ID not found: ${contactId}`);
        if (!target.rowIndex) throw new Error(`System Error: Missing rowIndex for Contact ${contactId}`);
        return target.rowIndex;
    }

    /**
     * [ZONE: CORE / OFFICIAL]
     * [Phase 7 Dashboard Interface]
     * 提供儀表板所需的完整正式聯絡人清單
     */
    async getAllOfficialContacts() {
        try {
            return await this._fetchOfficialContactsWithCompanies();
        } catch (error) {
            console.error('[ContactService] getAllOfficialContacts Failed:', error);
            return [];
        }
    }

    /**
     * [ZONE: RAW / POTENTIAL]
     * Reads aggregation stats from RAW contact pool (Google Sheets).
     */
    async getDashboardStats() {
        try {
            if (!this.contactRawReader) throw new Error('[ContactService] contactRawReader not configured');
            const contacts = await this.contactRawReader.getContacts();
            return {
                total: contacts.length,
                pending: contacts.filter(c => !c.status || c.status === 'Pending').length,
                processed: contacts.filter(c => c.status === 'Processed').length,
                dropped: contacts.filter(c => c.status === 'Dropped').length
            };
        } catch (error) {
            console.error('[ContactService] getDashboardStats Error:', error);
            return { total: 0, pending: 0, processed: 0, dropped: 0 };
        }
    }

    /**
     * [ZONE: RAW / POTENTIAL]
     * Fetches RAW contacts from Google Sheets.
     * Used for OCR intake, verification, and upgrade selection.
     */
    async getPotentialContacts(limit = 2000) {
        if (!this.contactRawReader) throw new Error('[ContactService] contactRawReader not configured');
        let contacts = await this.contactRawReader.getContacts();

        // Filter valid entries
        contacts = contacts.filter(c => c.name || c.company);

        // Sort by Created Time DESC
        contacts.sort((a, b) => {
            const dateA = new Date(a.createdTime);
            const dateB = new Date(b.createdTime);
            if (isNaN(dateB.getTime())) return -1;
            if (isNaN(dateA.getTime())) return 1;
            return dateB - dateA;
        });

        if (limit > 0) contacts = contacts.slice(0, limit);
        return contacts;
    }

    /**
     * [ZONE: RAW / POTENTIAL]
     * Search functionality for the Potential Pool.
     */
    async searchContacts(query) {
        try {
            let contacts = await this.getPotentialContacts(9999);
            if (query) {
                const searchTerm = query.toLowerCase();
                contacts = contacts.filter(c =>
                    (c.name && c.name.toLowerCase().includes(searchTerm)) ||
                    (c.company && c.company.toLowerCase().includes(searchTerm))
                );
            }
            return { data: contacts };
        } catch (error) {
            console.error('[ContactService] searchContacts Error:', error);
            throw error;
        }
    }

    /**
     * [ZONE: CORE / OFFICIAL]
     * Search functionality for Official Contacts.
     * Uses Hybrid Read Strategy.
     */
    async searchOfficialContacts(query, page = 1) {
        try {
            let contacts = await this._fetchOfficialContactsWithCompanies();

            if (query) {
                const searchTerm = query.toLowerCase();
                contacts = contacts.filter(c =>
                    (c.name && c.name.toLowerCase().includes(searchTerm)) ||
                    (c.companyName && c.companyName.toLowerCase().includes(searchTerm))
                );
            }

            const pageSize = (this.config && this.config.PAGINATION) ? this.config.PAGINATION.CONTACTS_PER_PAGE : 20;
            const startIndex = (page - 1) * pageSize;
            const paginated = contacts.slice(startIndex, startIndex + pageSize);

            return {
                data: paginated,
                pagination: {
                    current: page,
                    total: Math.ceil(contacts.length / pageSize),
                    totalItems: contacts.length,
                    hasNext: (startIndex + pageSize) < contacts.length,
                    hasPrev: page > 1
                }
            };
        } catch (error) {
            console.error('[ContactService] searchOfficialContacts Error:', error);
            throw error;
        }
    }

    /**
     * [ZONE: CORE / OFFICIAL]
     * Fetches a single Official Contact by ID.
     * Priority: SQL -> Fallback: Sheet.
     */
    async getContactById(contactId) {
        // SQL primary
        if (this.contactSqlReader) {
            try {
                const sqlContact = await this.contactSqlReader.getContactById(contactId);
                if (sqlContact) {
                    const allCompanies = await this.companyReader.getCompanyList();
                    const companyNameMap = new Map(allCompanies.map(c => [c.companyId, c.companyName]));
                    const mappedContact = this._mapSqlContact(sqlContact);
                    return this._mapOfficialContact(mappedContact, companyNameMap);
                }
                console.warn(`[ContactService] Contact ID ${contactId} not found in SQL. Attempting Fallback.`);
            } catch (error) {
                console.warn('[ContactService] SQL Single Read Error (Fallback):', error.message);
            }
        }

        // CORE sheet fallback
        const contacts = await this._fetchOfficialContactsWithCompanies(true);
        const contact = contacts.find(c => c.contactId === contactId);
        return contact || null;
    }

    /**
     * [ZONE: HYBRID / READ]
     * Retrieves contacts linked to an opportunity.
     * JOINS:
     * 1. CORE Link Table (opportunity_contact_links)
     * 2. CORE Contact List (Official)
     * 3. RAW Contact List (to fetch Drive Links/Card Images if available)
     */
    async getLinkedContacts(opportunityId) {
        try {
            if (!this.contactCoreReader) throw new Error('[ContactService] contactCoreReader not configured');
            if (!this.contactRawReader) throw new Error('[ContactService] contactRawReader not configured');

            const [allLinks, officialContacts, allPotentialContacts] = await Promise.all([
                this.contactCoreReader.getAllOppContactLinks(),   // CORE Link table
                this._fetchOfficialContactsWithCompanies(),       // SQL primary
                this.contactRawReader.getContacts()               // RAW (images/drive links)
            ]);

            const linkedContactIds = new Set();
            for (const link of allLinks) {
                if (link.opportunityId === opportunityId && link.status === 'active') {
                    linkedContactIds.add(link.contactId);
                }
            }
            if (linkedContactIds.size === 0) return [];

            const potentialCardMap = new Map();
            allPotentialContacts.forEach(pc => {
                if (pc.name && pc.company && pc.driveLink) {
                    const key = this._normalizeKey(pc.name) + '|' + this._normalizeKey(pc.company);
                    if (!potentialCardMap.has(key)) potentialCardMap.set(key, pc.driveLink);
                }
            });

            return officialContacts
                .filter(contact => linkedContactIds.has(contact.contactId))
                .map(contact => {
                    const companyName = contact.companyName || '';
                    let driveLink = '';

                    if (contact.name && companyName) {
                        const key = this._normalizeKey(contact.name) + '|' + this._normalizeKey(companyName);
                        driveLink = potentialCardMap.get(key) || '';
                    }

                    return {
                        contactId: contact.contactId,
                        sourceId: contact.sourceId,
                        name: contact.name,
                        companyId: contact.companyId,
                        department: contact.department,
                        position: contact.position,
                        mobile: contact.mobile,
                        phone: contact.phone,
                        email: contact.email,
                        companyName,
                        driveLink
                    };
                });

        } catch (error) {
            console.error('[ContactService] getLinkedContacts Error:', error);
            return [];
        }
    }

    // ============================================================
    // CORE CONTACT ZONE (PHASE 7: SQL ONLY WRITES)
    // ============================================================
    
    /**
     * [ZONE: CORE / OFFICIAL]
     * Create Official Contact
     * STRICT: SQL Writer Only. NO Sheet Writer.
     */
    async createContact(contactData, user) {
        if (!this.contactSqlWriter) {
            throw new Error('[ContactService] CRITICAL: ContactSqlWriter not configured. Create disallowed.');
        }

        // 1. Write to SQL
        const result = await this.contactSqlWriter.createContact(contactData, user);

        // 2. Invalidate Read Cache (if any)
        if (this.contactCoreReader && this.contactCoreReader.invalidateCache) {
            this.contactCoreReader.invalidateCache('contactList');
        }

        return result; // { success: true, id }
    }

    /**
     * [ZONE: CORE / OFFICIAL]
     * Update Official Contact
     * STRICT: SQL Writer Only. NO Sheet Writer.
     */
    async updateContact(contactId, updateData, user) {
        if (!this.contactSqlWriter) {
            throw new Error('[ContactService] CRITICAL: ContactSqlWriter not configured. Update disallowed.');
        }

        // 1. Write to SQL
        await this.contactSqlWriter.updateContact(contactId, updateData, user);

        // 2. Invalidate Read Cache
        if (this.contactCoreReader && this.contactCoreReader.invalidateCache) {
            this.contactCoreReader.invalidateCache('contactList');
        }

        return { success: true };
    }

    /**
     * [ZONE: CORE / OFFICIAL]
     * Delete Official Contact
     * STRICT: SQL Writer Only. NO Sheet Writer.
     */
    async deleteContact(contactId, user) {
        if (!this.contactSqlWriter) {
            throw new Error('[ContactService] CRITICAL: ContactSqlWriter not configured. Delete disallowed.');
        }

        // 1. Delete from SQL
        await this.contactSqlWriter.deleteContact(contactId);

        // 2. Invalidate Read Cache
        if (this.contactCoreReader && this.contactCoreReader.invalidateCache) {
            this.contactCoreReader.invalidateCache('contactList');
        }

        return { success: true };
    }

    // ============================================================
    // RAW CONTACT ZONE (POTENTIAL CONTACTS - SHEET ONLY)
    // ============================================================

    /**
     * [ZONE: RAW / POTENTIAL]
     * Update Potential Contact (RAW)
     * USAGE: Sheet Writer (rowIndex based)
     * Used for updating status flags (e.g., 'Processed', 'Dropped').
     */
    async updatePotentialContact(rowIndex, updateData, modifier) {
        try {
            if (!this.contactRawReader) throw new Error('[ContactService] contactRawReader not configured');
            
            // 1. Resolve target via Reader
            const allContacts = await this.contactRawReader.getContacts();
            const target = allContacts.find(c => c.rowIndex === parseInt(rowIndex));
            if (!target) throw new Error(`找不到潛在客戶 Row: ${rowIndex}`);

            // 2. Prepare Merge
            const mergedData = { ...target, ...updateData };

            // 3. Handle Notes Append Logic
            if (updateData.notes) {
                const oldNotes = target.notes || '';
                const newNoteEntry = `[${modifier} ${new Date().toLocaleDateString()}] ${updateData.notes}`;
                mergedData.notes = oldNotes ? `${oldNotes}\n${newNoteEntry}` : newNoteEntry;
            }

            // 4. Write to Sheet (Legacy Writer)
            await this.contactWriter.writePotentialContactRow(rowIndex, mergedData);

            // 5. Invalidate RAW Cache
            if (this.contactRawReader.invalidateCache) {
                this.contactRawReader.invalidateCache('contacts');
            }

            return { success: true };
        } catch (error) {
            console.error('[ContactService] updatePotentialContact Error:', error);
            throw error;
        }
    }
}

module.exports = ContactService;