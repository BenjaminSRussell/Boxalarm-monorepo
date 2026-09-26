// Every backend Lambda entry point infrastructure/ wires by service/function
// key. `npm run bundle` bundles each into dist/<service>/<function>/index.mjs;
// infrastructure's lambdaCode() helper looks up that same key.
export const LAMBDA_ENTRIES = [
  {
    service: 'platform-service',
    function: 'credential-recovery-monitor',
    entry: 'src/services/platform-service/credential-recovery-monitor/handler.ts',
  },
  {
    service: 'platform-service',
    function: 'session-revocation-member-status',
    entry: 'src/services/platform-service/session-revocation/memberStatusRevocationHandler.ts',
  },
  {
    service: 'platform-service',
    function: 'session-revocation-device-loss',
    entry: 'src/services/platform-service/session-revocation/deviceLossHandler.ts',
  },
  {
    service: 'platform-service',
    function: 'audit',
    entry: 'src/services/platform-service/audit/handler.ts',
  },
  {
    service: 'platform-service',
    function: 'config',
    entry: 'src/services/platform-service/config/handler.ts',
  },
  {
    service: 'platform-service',
    function: 'export',
    entry: 'src/services/platform-service/export/handler.ts',
  },
  {
    service: 'platform-service',
    function: 'export-worker',
    entry: 'src/services/platform-service/export/worker.ts',
  },
  {
    service: 'platform-service',
    function: 'retention-disposal',
    entry: 'src/services/platform-service/retention/disposalHandler.ts',
  },
  {
    service: 'platform-service',
    function: 'outbox-publisher',
    entry: 'src/services/platform-service/outbox-publisher/handler.ts',
  },
  {
    service: 'personnel-service',
    function: 'members-create',
    entry: 'src/services/personnel-service/members/create.ts',
  },
  {
    service: 'personnel-service',
    function: 'members-list',
    entry: 'src/services/personnel-service/members/list.ts',
  },
  {
    service: 'personnel-service',
    function: 'members-get',
    entry: 'src/services/personnel-service/members/get.ts',
  },
  {
    service: 'personnel-service',
    function: 'members-update-status',
    entry: 'src/services/personnel-service/members/updateStatus.ts',
  },
  {
    service: 'personnel-service',
    function: 'members-update-profile',
    entry: 'src/services/personnel-service/members/updateMember.ts',
  },
  {
    service: 'personnel-service',
    function: 'quals',
    entry: 'src/services/personnel-service/quals/handler.ts',
  },
  {
    service: 'personnel-service',
    function: 'attendance-record',
    entry: 'src/services/personnel-service/attendance/handler.ts',
  },
  {
    service: 'personnel-service',
    function: 'attendance-query',
    entry: 'src/services/personnel-service/attendance/queryHandler.ts',
  },
  {
    service: 'personnel-service',
    function: 'availability-create',
    entry: 'src/services/personnel-service/availability/handler.ts',
  },
  {
    service: 'personnel-service',
    function: 'availability-expiry',
    entry: 'src/services/personnel-service/availability/expiryHandler.ts',
  },
  {
    service: 'personnel-service',
    function: 'losap-get-member-total',
    entry: 'src/services/personnel-service/losap/getMemberLosap.ts',
  },
  {
    service: 'personnel-service',
    function: 'losap-update-rules',
    entry: 'src/services/personnel-service/losap/updateRules.ts',
  },
  {
    service: 'personnel-service',
    function: 'losap-year-end-report',
    entry: 'src/services/personnel-service/losap/yearEndReport.ts',
  },
  {
    service: 'personnel-service',
    function: 'shifts',
    entry: 'src/services/personnel-service/shifts/handler.ts',
  },
  {
    service: 'training-service',
    function: 'certifications-create',
    entry: 'src/services/training-service/certifications/create.ts',
  },
  {
    service: 'training-service',
    function: 'certifications-list',
    entry: 'src/services/training-service/certifications/list.ts',
  },
  {
    service: 'training-service',
    function: 'certifications-revoke',
    entry: 'src/services/training-service/certifications/revoke.ts',
  },
  {
    service: 'training-service',
    function: 'certifications-expiring',
    entry: 'src/services/training-service/certifications/expiring.ts',
  },
  {
    service: 'training-service',
    function: 'certification-expiry-scanner',
    entry: 'src/services/training-service/certificationExpiryScanner/handler.ts',
  },
  {
    service: 'training-service',
    function: 'events-create',
    entry: 'src/services/training-service/createEventHandler.ts',
  },
  {
    service: 'training-service',
    function: 'events-list',
    entry: 'src/services/training-service/listEventsHandler.ts',
  },
  {
    service: 'training-service',
    function: 'events-signup',
    entry: 'src/services/training-service/signupHandler.ts',
  },
  {
    service: 'training-service',
    function: 'hours',
    entry: 'src/services/training-service/hoursHandler.ts',
  },
  {
    service: 'training-service',
    function: 'reports-iso',
    entry: 'src/services/training-service/reports/iso.ts',
  },
  {
    service: 'training-service',
    function: 'transcript-get',
    entry: 'src/services/training-service/transcript/get.ts',
  },
  {
    service: 'incident-service',
    function: 'create',
    entry: 'src/services/incident-service/createIncident.ts',
  },
  {
    service: 'incident-service',
    function: 'update',
    entry: 'src/services/incident-service/updateIncident.ts',
  },
  {
    service: 'incident-service',
    function: 'narrative',
    entry: 'src/services/incident-service/putNarrative.ts',
  },
  {
    service: 'incident-service',
    function: 'response-times',
    entry: 'src/services/incident-service/putResponseTimes.ts',
  },
  {
    service: 'incident-service',
    function: 'exposures',
    entry: 'src/services/incident-service/putExposures.ts',
  },
  {
    service: 'incident-service',
    function: 'get',
    entry: 'src/services/incident-service/getIncident.ts',
  },
  {
    service: 'incident-service',
    function: 'search',
    entry: 'src/services/incident-service/searchIncidents.ts',
  },
  {
    service: 'incident-service',
    function: 'dispatch-alert-consumer',
    entry: 'src/services/incident-service/dispatchAlertConsumer.ts',
  },
  {
    service: 'incident-service',
    function: 'dispatch-response-consumer',
    entry: 'src/services/incident-service/dispatchResponseConsumer.ts',
  },
  {
    service: 'incident-service',
    function: 'schema-version-refresh',
    entry: 'src/services/incident-service/schemaVersion/refreshScanner/handler.ts',
  },
  {
    service: 'incident-service',
    function: 'submit',
    entry: 'src/services/incident-service/submit.ts',
  },
  {
    service: 'incident-service',
    function: 'submission-worker',
    entry: 'src/services/incident-service/neris/submissionWorker.ts',
  },
  {
    service: 'incident-service',
    function: 'outbox-drain',
    entry: 'src/services/incident-service/outboxDrainHandler.ts',
  },
  {
    service: 'incident-service',
    function: 'submission-get',
    entry: 'src/services/incident-service/getSubmission.ts',
  },
  {
    service: 'incident-service',
    function: 'submission-retry',
    entry: 'src/services/incident-service/retrySubmission.ts',
  },
  {
    service: 'reporting-service',
    function: 'losap-year-end',
    entry: 'src/services/reporting-service/losap/handler.ts',
  },
  {
    service: 'reporting-service',
    function: 'grants',
    entry: 'src/services/reporting-service/grants/handler.ts',
  },
  {
    service: 'reporting-service',
    function: 'membership-trends',
    entry: 'src/services/reporting-service/membershipTrends/handler.ts',
  },
  {
    service: 'alerting-service',
    function: 'dispatches-create',
    entry: 'src/services/alerting-service/dispatches/handler.ts',
  },
  {
    service: 'alerting-service',
    function: 'responses',
    entry: 'src/services/alerting-service/responses/handler.ts',
  },
  {
    service: 'alerting-service',
    function: 'roster',
    entry: 'src/services/alerting-service/roster/handler.ts',
  },
  {
    service: 'alerting-service',
    function: 'dispatch-detail',
    entry: 'src/services/alerting-service/dispatches/detail/handler.ts',
  },
  {
    service: 'alerting-service',
    function: 'self-test-post',
    entry: 'src/services/alerting-service/selfTest/postHandler.ts',
  },
  {
    service: 'alerting-service',
    function: 'self-test-get',
    entry: 'src/services/alerting-service/selfTest/getHandler.ts',
  },
  {
    service: 'alerting-service',
    function: 'audit',
    entry: 'src/services/alerting-service/audit/handler.ts',
  },
  {
    service: 'alerting-service',
    function: 'receipts-get',
    entry: 'src/services/alerting-service/receipts/getDeliveryReceiptsHandler.ts',
  },
  {
    service: 'alerting-service',
    function: 'sms-receipt-webhook',
    entry: 'src/services/alerting-service/receipts/smsDeliveryReceiptHandler.ts',
  },
  {
    service: 'alerting-service',
    function: 'voice-receipt-webhook',
    entry: 'src/services/alerting-service/receipts/voiceDeliveryReceiptHandler.ts',
  },
  {
    service: 'alerting-service',
    function: 'push-receipt-webhook',
    entry: 'src/services/alerting-service/receipts/pushReceiptHandler.ts',
  },
  {
    service: 'alerting-service',
    function: 'fan-out',
    entry: 'src/services/alerting-service/fanout/handler.ts',
  },
  {
    service: 'alerting-service',
    function: 'push-worker',
    entry: 'src/services/alerting-service/channels/push/worker.ts',
  },
  {
    service: 'alerting-service',
    function: 'sms-worker',
    entry: 'src/services/alerting-service/channels/sms/worker.ts',
  },
  {
    service: 'alerting-service',
    function: 'voice-worker',
    entry: 'src/services/alerting-service/channels/voice/worker.ts',
  },
  {
    service: 'alerting-service',
    function: 'escalation',
    entry: 'src/services/alerting-service/escalation/escalationHandler.ts',
  },
  {
    service: 'alerting-service',
    function: 'tone-evaluator',
    entry: 'src/services/alerting-service/escalation/toneEvaluatorHandler.ts',
  },
  {
    service: 'alerting-service',
    function: 'eligibility-staleness-check',
    entry: 'src/services/alerting-service/eligibility/staleness/checkHandler.ts',
  },
  {
    service: 'alerting-service',
    function: 'member-updated-consumer',
    entry: 'src/services/alerting-service/eligibility/memberUpdatedHandler.ts',
  },
  {
    service: 'alerting-service',
    function: 'canary',
    entry: 'src/services/alerting-service/canary/handler.ts',
  },
  {
    service: 'alerting-service',
    function: 'canary-status',
    entry: 'src/services/alerting-service/canary/statusHandler.ts',
  },
  {
    service: 'alerting-service',
    function: 'device-report-state',
    entry: 'src/services/alerting-service/devices/reportStateHandler.ts',
  },
  {
    service: 'alerting-service',
    function: 'diagnostics',
    entry: 'src/services/alerting-service/diagnostics/handler.ts',
  },
  {
    service: 'alerting-service',
    function: 'diagnostics-self',
    entry: 'src/services/alerting-service/diagnostics/selfHandler.ts',
  },
  {
    service: 'alerting-service',
    function: 'delivery-baseline',
    entry: 'src/services/alerting-service/audit/deliveryBaselineHandler.ts',
  },
  {
    service: 'personnel-service',
    function: 'push-tokens-register',
    entry: 'src/services/personnel-service/pushTokens/registerToken.ts',
  },
  {
    service: 'personnel-service',
    function: 'push-tokens-revoke',
    entry: 'src/services/personnel-service/pushTokens/revokeToken.ts',
  },
  {
    service: 'apparatus-service',
    function: 'riding-board-get',
    entry: 'src/services/apparatus-service/ridingBoard/getHandler.ts',
  },
  {
    service: 'apparatus-service',
    function: 'riding-board-assign',
    entry: 'src/services/apparatus-service/ridingBoard/assignHandler.ts',
  },
  {
    service: 'alerting-service',
    function: 'outbox-drain',
    entry: 'src/services/alerting-service/outboxDrainHandler.ts',
  },
  {
    service: 'personnel-service',
    function: 'cert-expired-reactor',
    entry: 'src/services/personnel-service/events/certExpiredReactor.ts',
  },
  {
    service: 'alerting-service',
    function: 'eligibility-changed-consumer',
    entry: 'src/services/alerting-service/eligibility/eligibilityChangedConsumer.ts',
  },
  {
    service: 'alerting-service',
    function: 'availability-changed-consumer',
    entry: 'src/services/alerting-service/eligibility/consumer.ts',
  },
  {
    service: 'personnel-service',
    function: 'shift-completion',
    entry: 'src/services/personnel-service/shifts/completionHandler.ts',
  },
  {
    service: 'reporting-service',
    function: 'cutover-decision-get',
    entry: 'src/services/reporting-service/cutoverDecision/get.ts',
  },
  {
    service: 'reporting-service',
    function: 'cutover-decision-post',
    entry: 'src/services/reporting-service/cutoverDecision/post.ts',
  },
  {
    service: 'reporting-service',
    function: 'projections',
    entry: 'src/services/reporting-service/projections/handler.ts',
  },
  {
    service: 'reporting-service',
    function: 'dashboard',
    entry: 'src/services/reporting-service/dashboard/handler.ts',
  },
  {
    service: 'reporting-service',
    function: 'response-times',
    entry: 'src/services/reporting-service/responseTimes/handler.ts',
  },
  {
    service: 'reporting-service',
    function: 'iso',
    entry: 'src/services/reporting-service/iso/handler.ts',
  },
  {
    service: 'reporting-service',
    function: 'export',
    entry: 'src/services/reporting-service/export/handler.ts',
  },
  {
    service: 'reporting-service',
    function: 'export-worker',
    entry: 'src/services/reporting-service/export/worker.ts',
  },
  {
    service: 'notification-service',
    function: 'inbox',
    entry: 'src/services/notification-service/inbox/handler.ts',
  },
  {
    service: 'notification-service',
    function: 'preferences',
    entry: 'src/services/notification-service/preferences/handler.ts',
  },
  {
    service: 'notification-service',
    function: 'cert-expiry-consumer',
    entry: 'src/services/notification-service/events/certExpiryConsumer.ts',
  },
  {
    service: 'notification-service',
    function: 'digest-job',
    entry: 'src/services/notification-service/digest/digestJob.ts',
  },
];
