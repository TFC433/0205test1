/*
 * FILE: services/event-log-service.js
 * VERSION: 6.0.0
 * DATE: 2026-02-09
 * CHANGELOG:
 * - Phase 7: Migrate EventLog Write Authority to SQL (Schema Locked)
 */

class EventLogService {
    /**
     * @param {EventLogReader} eventReader 
     * @param {OpportunityReader} oppReader 
     * @param {CompanyReader} companyReader 
     * @param {SystemReader} systemReader 
     * @param {CalendarService} calendarService 
     * @param {EventLogSqlReader} eventLogSqlReader
     * @param {EventLogSqlWriter} eventLogSqlWriter
     */
    constructor(eventReader, oppReader, companyReader, systemReader, calendarService, eventLogSqlReader, eventLogSqlWriter) {
        this.eventReader = eventReader;
        this.oppReader = oppReader;
        this.companyReader = companyReader;
        this.systemReader = systemReader;
        this.calendarService = calendarService;
        this.eventLogSqlReader = eventLogSqlReader;
        this.eventLogSqlWriter = eventLogSqlWriter;
    }

    _invalidateEventCacheSafe() {
        try {
            if (this.eventReader && typeof this.eventReader.invalidateCache === 'function') {
                this.eventReader.invalidateCache('eventLogs');
            } else if (this.eventReader && this.eventReader.cache) {
                this.eventReader.cache = {};
            }
        } catch (e) {
            // do nothing
        }
    }

    async getAllEvents() {
        try {
            let events;
            try {
                if (this.eventLogSqlReader) {
                    events = await this.eventLogSqlReader.getEventLogs();
                    if (!Array.isArray(events)) throw new Error('SQL returned invalid structure');
                } else {
                    throw new Error('SQL Reader not injected');
                }
            } catch (sqlError) {
                console.warn('[EventLogService] getAllEvents: SQL Read Failed, fallback to Sheet.', sqlError.message);
                events = await this.eventReader.getEventLogs();
            }

            const [opps, comps] = await Promise.all([
                this.oppReader.getOpportunities(),
                this.companyReader.getCompanyList()
            ]);

            const oppMap = new Map(opps.map(o => [o.opportunityId, o.opportunityName]));
            const compMap = new Map(comps.map(c => [c.companyId, c.companyName]));

            return events.map(raw => {
                const e = { ...raw };
                if (!e.id && e.eventId) e.id = e.eventId;
                if (e.opportunityId) e.opportunityName = oppMap.get(e.opportunityId) || e.opportunityId;
                if (e.companyId) e.companyName = compMap.get(e.companyId) || e.companyId;
                return e;
            });
        } catch (error) {
            console.error('[EventLogService] getAllEvents Error:', error);
            return [];
        }
    }

    async getEventById(eventId) {
        try {
            let rawEvent;
            try {
                if (this.eventLogSqlReader) {
                    rawEvent = await this.eventLogSqlReader.getEventLogById(eventId);
                    if (!rawEvent) throw new Error(`Event ${eventId} not found in SQL`);
                } else {
                    throw new Error('SQL Reader not injected');
                }
            } catch (sqlError) {
                console.warn(`[EventLogService] getEventById: SQL Read Failed for ${eventId}, fallback to Sheet.`, sqlError.message);
                rawEvent = await this.eventReader.getEventLogById(eventId);
            }

            if (!rawEvent) return null;

            const event = { ...rawEvent };
            if (!event.id && event.eventId) event.id = event.eventId;

            try {
                const [opps, comps] = await Promise.all([
                    this.oppReader.getOpportunities(),
                    this.companyReader.getCompanyList()
                ]);

                const oppMap = new Map(opps.map(o => [o.opportunityId, o.opportunityName]));
                const compMap = new Map(comps.map(c => [c.companyId, c.companyName]));

                if (event.opportunityId) event.opportunityName = oppMap.get(event.opportunityId) || event.opportunityId;
                if (event.companyId) event.companyName = compMap.get(event.companyId) || event.companyId;
            } catch (joinError) {
                console.warn(`[EventLogService] Join failed for ${eventId}, returning raw clone.`, joinError);
            }

            return event;
        } catch (error) {
            console.error(`[EventLogService] getEventById Error (${eventId}):`, error);
            return null;
        }
    }

    async createEvent(data, user) {
        try {
            const modifier = user?.displayName || user?.username || 'System';
            
            // Validate or Generate ID
            const eventId = data.eventId || data.id || `evt_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

            // Strict Schema Mapping
            const sqlPayload = {
                event_id: eventId,
                opportunity_id: data.opportunityId || null,
                company_id: data.companyId || null,
                event_type: data.eventType || null,
                event_title: data.eventName || data.eventTitle || null,
                content_summary: data.eventContent || data.contentSummary || null,
                recorder: modifier,
                created_time: data.createdTime ? new Date(data.createdTime) : new Date()
            };

            const result = await this.eventLogSqlWriter.createEventLog(sqlPayload);
            this._invalidateEventCacheSafe();

            // Calendar Side Effect
            if (result.success && data.syncToCalendar === 'true') {
                try {
                    const startIso = new Date(sqlPayload.created_time).toISOString();
                    const endIso = new Date(Date.now() + 3600000).toISOString();

                    const calendarEvent = {
                        summary: `[${sqlPayload.event_type}] ${sqlPayload.event_title}`,
                        description: sqlPayload.content_summary || '',
                        start: { dateTime: startIso },
                        end: { dateTime: endIso }
                    };

                    await this.calendarService.createEvent(calendarEvent);
                } catch (calError) {
                    console.warn('[EventLogService] Calendar sync failed:', calError);
                }
            }

            return result;
        } catch (error) {
            console.error('[EventLogService] createEvent Error:', error);
            throw error;
        }
    }

    async updateEventLog(idOrRowIndex, data, modifier) {
        try {
            // Strict Phase 7 Check: Refuse Row Index
            if (typeof idOrRowIndex === 'number' || (typeof idOrRowIndex === 'string' && !isNaN(Number(idOrRowIndex)))) {
                throw new Error('[Phase 7] RowIndex is strictly prohibited. Use Event ID.');
            }

            const eventId = idOrRowIndex;
            const user = modifier?.displayName || modifier || 'System';

            // Strict Schema Mapping for Update (No created_time)
            const sqlPayload = {};
            if (data.opportunityId !== undefined) sqlPayload.opportunity_id = data.opportunityId;
            if (data.companyId !== undefined) sqlPayload.company_id = data.companyId;
            if (data.eventType !== undefined) sqlPayload.event_type = data.eventType;
            
            // Map legacy fields
            if (data.eventName !== undefined) sqlPayload.event_title = data.eventName;
            if (data.eventTitle !== undefined) sqlPayload.event_title = data.eventTitle;
            
            if (data.eventContent !== undefined) sqlPayload.content_summary = data.eventContent;
            if (data.contentSummary !== undefined) sqlPayload.content_summary = data.contentSummary;
            
            sqlPayload.recorder = user;

            const result = await this.eventLogSqlWriter.updateEventLog(eventId, sqlPayload);
            this._invalidateEventCacheSafe();
            return result;
        } catch (error) {
            console.error('[EventLogService] updateEventLog Error:', error);
            throw error;
        }
    }

    async deleteEventLog(eventId, user) {
        try {
            const modifier = user?.displayName || user || 'System';
            const result = await this.eventLogSqlWriter.deleteEventLog(eventId, modifier);
            this._invalidateEventCacheSafe();
            return result;
        } catch (error) {
            console.error(`[EventLogService] deleteEventLog Error (${eventId}):`, error);
            throw error;
        }
    }

    async getEventTypes() {
        try {
            const config = await this.systemReader.getSystemConfig();
            return config['事件類型'] || [];
        } catch (error) {
            console.error('[EventLogService] getEventTypes Error:', error);
            return [];
        }
    }
}

module.exports = EventLogService;