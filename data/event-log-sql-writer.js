/*
 * FILE: data/event-log-sql-writer.js
 * VERSION: 1.0.0
 * DATE: 2026-02-09
 * CHANGELOG:
 * - Phase 7: Migrate EventLog Write Authority to SQL (Schema Locked)
 */

const { supabase } = require('../config/supabase');

class EventLogSqlWriter {
    async createEventLog(payload) {
        try {
            const { data, error } = await supabase
                .from('event_logs')
                .insert([payload])
                .select('event_id')
                .single();

            if (error) throw error;
            return { success: true, id: data.event_id };
        } catch (error) {
            console.error('[EventLogSqlWriter] createEventLog Error:', error);
            throw error;
        }
    }

    async updateEventLog(eventId, payload) {
        try {
            const { data, error } = await supabase
                .from('event_logs')
                .update(payload)
                .eq('event_id', eventId)
                .select('event_id');

            if (error) throw error;
            if (!data || data.length === 0) {
                return { success: false, message: 'Event not found or no changes made' };
            }
            return { success: true };
        } catch (error) {
            console.error('[EventLogSqlWriter] updateEventLog Error:', error);
            throw error;
        }
    }

    async deleteEventLog(eventId) {
        try {
            const { data, error } = await supabase
                .from('event_logs')
                .delete()
                .eq('event_id', eventId)
                .select('event_id');

            if (error) throw error;
            if (!data || data.length === 0) {
                return { success: false, message: 'Event not found' };
            }
            return { success: true };
        } catch (error) {
            console.error('[EventLogSqlWriter] deleteEventLog Error:', error);
            throw error;
        }
    }
}

module.exports = EventLogSqlWriter;