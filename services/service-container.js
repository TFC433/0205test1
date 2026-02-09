/**
 * services/service-container.js
 * 服務容器 (IoC Container)
 * @version 8.0.2 (Phase 7: Company/Opportunity Log SQL Fix)
 * @date 2026-02-09
 * @description
 * - CompanyService / OpportunityService 的 side-effect logging 改注入 interactionSqlWriter（避免寫回 Sheets）
 * - 其餘維持 v8.0.1
 */

const config = require('../config');
const dateHelpers = require('../utils/date-helpers');

// --- Import Infrastructure Services ---
const GoogleClientService = require('./google-client-service');

// --- Import Readers ---
const ContactReader = require('../data/contact-reader');
const ContactSqlReader = require('../data/contact-sql-reader');
const CompanyReader = require('../data/company-reader');
const CompanySqlReader = require('../data/company-sql-reader');
const OpportunityReader = require('../data/opportunity-reader');
const OpportunitySqlReader = require('../data/opportunity-sql-reader');
const InteractionReader = require('../data/interaction-reader');
const InteractionSqlReader = require('../data/interaction-sql-reader');
const EventLogReader = require('../data/event-log-reader');
const EventLogSqlReader = require('../data/event-log-sql-reader');
const SystemReader = require('../data/system-reader');
const WeeklyBusinessReader = require('../data/weekly-business-reader');
const WeeklyBusinessSqlReader = require('../data/weekly-business-sql-reader');
const AnnouncementReader = require('../data/announcement-reader');
const AnnouncementSqlReader = require('../data/announcement-sql-reader');
const ProductReader = require('../data/product-reader');

// --- Import Writers ---
const ContactWriter = require('../data/contact-writer');
const ContactSqlWriter = require('../data/contact-sql-writer');
const CompanyWriter = require('../data/company-writer');
const CompanySqlWriter = require('../data/company-sql-writer');
const OpportunityWriter = require('../data/opportunity-writer');
const OpportunitySqlWriter = require('../data/opportunity-sql-writer');
const InteractionWriter = require('../data/interaction-writer');
const InteractionSqlWriter = require('../data/interaction-sql-writer');
const EventLogWriter = require('../data/event-log-writer');
const EventLogSqlWriter = require('../data/event-log-sql-writer');
const SystemWriter = require('../data/system-writer');
const WeeklyBusinessWriter = require('../data/weekly-business-writer');
const WeeklyBusinessSqlWriter = require('../data/weekly-business-sql-writer');
const AnnouncementWriter = require('../data/announcement-writer');
const AnnouncementSqlWriter = require('../data/announcement-sql-writer');
const ProductWriter = require('../data/product-writer');

// --- Import Domain Services ---
const AuthService = require('./auth-service');
const DashboardService = require('./dashboard-service');
const OpportunityService = require('./opportunity-service');
const ContactService = require('./contact-service');
const CompanyService = require('./company-service');
const InteractionService = require('./interaction-service');
const EventLogService = require('./event-log-service');
const CalendarService = require('./calendar-service');
const SalesAnalysisService = require('./sales-analysis-service');
const WeeklyBusinessService = require('./weekly-business-service');
const WorkflowService = require('./workflow-service');
const ProductService = require('./product-service');
const AnnouncementService = require('./announcement-service');
const EventService = require('./event-service');
const SystemService = require('./system-service');

// --- Import Controllers ---
const AuthController = require('../controllers/auth.controller');
const SystemController = require('../controllers/system.controller');
const AnnouncementController = require('../controllers/announcement.controller');
const OpportunityController = require('../controllers/opportunity.controller');
const ContactController = require('../controllers/contact.controller');
const CompanyController = require('../controllers/company.controller');
const InteractionController = require('../controllers/interaction.controller');
const ProductController = require('../controllers/product.controller');
const WeeklyController = require('../controllers/weekly.controller');

let services = null;

async function initializeServices() {
    if (services) return services;

    console.log('🚀 [System] 正在初始化 Service Container (v8.0.2 Phase 7 Log SQL Fix)...');

    try {
        // 1. Infrastructure
        const googleClientService = new GoogleClientService();
        const sheets = await googleClientService.getSheetsClient();
        const drive = await googleClientService.getDriveClient();
        const calendar = await googleClientService.getCalendarClient();

        // 2. Readers
        const contactRawReader = new ContactReader(sheets, config.IDS.RAW);
        const contactCoreReader = new ContactReader(sheets, config.IDS.CORE);
        const contactSqlReader = new ContactSqlReader();

        const companyReader = new CompanyReader(sheets, config.IDS.CORE);
        const companySqlReader = new CompanySqlReader();

        const opportunityReader = new OpportunityReader(sheets, config.IDS.CORE);
        const opportunitySqlReader = new OpportunitySqlReader();

        const interactionReader = new InteractionReader(sheets, config.IDS.CORE);
        const interactionSqlReader = new InteractionSqlReader();

        const eventLogReader = new EventLogReader(sheets, config.IDS.CORE);
        const eventLogSqlReader = new EventLogSqlReader();

        const weeklyReader = new WeeklyBusinessReader(sheets, config.IDS.CORE);
        const weeklySqlReader = new WeeklyBusinessSqlReader();

        const announcementReader = new AnnouncementReader(sheets, config.IDS.CORE);
        const announcementSqlReader = new AnnouncementSqlReader();

        const systemReader = new SystemReader(sheets, config.IDS.SYSTEM);
        const productReader = new ProductReader(sheets, config.IDS.PRODUCT);

        // 3. Writers
        const contactWriter = new ContactWriter(sheets, config.IDS.RAW, contactRawReader);
        const contactSqlWriter = new ContactSqlWriter();

        const companyWriter = new CompanyWriter(sheets, config.IDS.CORE, companyReader);
        const companySqlWriter = new CompanySqlWriter();

        const opportunityWriter = new OpportunityWriter(
            sheets,
            config.IDS.CORE,
            opportunityReader,
            contactCoreReader
        );
        const opportunitySqlWriter = new OpportunitySqlWriter();

        const interactionWriter = new InteractionWriter(sheets, config.IDS.CORE, interactionReader);
        const interactionSqlWriter = new InteractionSqlWriter();

        const eventLogWriter = new EventLogWriter(sheets, config.IDS.CORE, eventLogReader);
        const eventLogSqlWriter = new EventLogSqlWriter();

        const weeklyWriter = new WeeklyBusinessWriter(sheets, config.IDS.CORE, weeklyReader);
        const weeklySqlWriter = new WeeklyBusinessSqlWriter();

        const announcementWriter = new AnnouncementWriter(sheets, config.IDS.CORE, announcementReader);
        const announcementSqlWriter = new AnnouncementSqlWriter();

        const systemWriter = new SystemWriter(sheets, config.IDS.SYSTEM, systemReader);
        const productWriter = new ProductWriter(sheets, config.IDS.PRODUCT, productReader);

        // 4. Domain Services
        const calendarService = new CalendarService(calendar);
        const authService = new AuthService(systemReader, systemWriter);

        const announcementService = new AnnouncementService({
            announcementSqlReader,
            announcementSqlWriter
        });

        const systemService = new SystemService(systemReader, systemWriter);

        const contactService = new ContactService(
            contactRawReader,
            contactCoreReader,
            contactWriter,
            companyReader,
            config,
            contactSqlReader,
            contactSqlWriter
        );

        // ✅ FIX: CompanyService 的 logging writer 改用 interactionSqlWriter（取代 interactionWriter）
        const companyService = new CompanyService(
            companyReader, companyWriter,
            contactCoreReader, contactWriter,
            opportunityReader, opportunityWriter,
            interactionReader, interactionSqlWriter,   // <-- CHANGED (was interactionWriter)
            eventLogReader, systemReader,
            companySqlReader,
            contactService,
            companySqlWriter
        );

        // ✅ FIX: OpportunityService 的 logging writer 改用 interactionSqlWriter（取代 interactionWriter）
        const opportunityService = new OpportunityService({
            config,
            opportunityReader,
            opportunityWriter,
            contactReader: contactCoreReader,
            contactWriter,
            companyReader,
            companyWriter,
            interactionReader,
            interactionWriter: interactionSqlWriter,   // <-- CHANGED (was interactionWriter)
            eventLogReader,
            systemReader,
            opportunitySqlReader,
            opportunitySqlWriter,
            contactService
        });

        const interactionService = new InteractionService(
            interactionReader,
            interactionSqlWriter,
            opportunityReader,
            companyReader,
            interactionSqlReader
        );

        const eventLogService = new EventLogService(
            eventLogReader,
            opportunityReader,
            companyReader,
            systemReader,
            calendarService,
            eventLogSqlReader,
            eventLogSqlWriter
        );

        const weeklyBusinessService = new WeeklyBusinessService({
            weeklyBusinessReader: weeklyReader,
            weeklyBusinessSqlReader: weeklySqlReader,
            weeklyBusinessSqlWriter: weeklySqlWriter,
            dateHelpers,
            calendarService,
            systemReader,
            opportunityService,
            config
        });

        const salesAnalysisService = new SalesAnalysisService(opportunityReader, systemReader, config);
        const productService = new ProductService(productReader, productWriter, systemReader, systemWriter);

        const dashboardService = new DashboardService(
            config,
            opportunityReader,
            contactService,
            interactionReader,
            eventLogReader,
            systemReader,
            weeklyBusinessService,
            companyReader,
            calendarService
        );

        const workflowService = new WorkflowService(
            opportunityService,
            interactionService,
            contactService
        );

        const eventService = new EventService(
            calendarService,
            interactionService,
            weeklyBusinessService,
            opportunityService,
            config,
            dateHelpers
        );

        // 5. Controllers
        const authController = new AuthController(authService);
        const systemController = new SystemController(systemService, dashboardService);
        const announcementController = new AnnouncementController(announcementService);
        const contactController = new ContactController(contactService, workflowService, contactWriter);
        const companyController = new CompanyController(companyService);
        const opportunityController = new OpportunityController(
            opportunityService,
            workflowService,
            dashboardService,
            opportunityReader,
            opportunityWriter
        );
        const interactionController = new InteractionController(interactionService);
        const productController = new ProductController(productService);
        const weeklyController = new WeeklyController(weeklyBusinessService);

        console.log('✅ Service Container 初始化完成');

        services = {
            googleClientService,
            authService, contactService, companyService,
            opportunityService, interactionService, eventLogService, calendarService,
            weeklyBusinessService, salesAnalysisService, dashboardService,
            workflowService, productService,
            announcementService,
            eventService,
            systemService,
            authController,
            systemController,
            announcementController,
            contactController,
            companyController,
            opportunityController,
            interactionController,
            productController,
            weeklyController,
            contactWriter,
            contactRawReader,
            contactCoreReader,
            weeklyBusinessReader: weeklyReader,
            weeklyBusinessWriter: weeklyWriter,
            systemReader, systemWriter,
            interactionWriter,          // 保留：若還有 RAW/Legacy 需要，但不應被 CORE side-effect 用到
            eventLogReader
        };

        return services;

    } catch (error) {
        console.error('⚠ 系統啟動失敗 (Service Container):', error.message);
        console.error(error.stack);
        throw error;
    }
}

module.exports = initializeServices;
