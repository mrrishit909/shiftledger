// Literal synthetic fixtures. All people, facilities and rules are fictional.
// Each variant is written out in full (not derived from the golden fixture), and each
// function returns a fresh object so callers can never mutate the oracle.

const fictionalRules = () => ({
  rulesetId: 'SL-FICTIONAL-RULES-1',
  fictional: true,
  approvalStatus: 'ILLUSTRATIVE_UNAPPROVED',
  reportableRoles: ['CNA', 'RN'],
  eligibleStatuses: ['APPROVED'],
  toleranceMinutes: 0,
});

/** SL-SYN-001 golden fixture: 1560 raw / 1080 dedup / 1020 support / 1080 schedule. */
export function goldenFixture() {
  return {
    schemaVersion: 'shiftledger.dataset.v1',
    datasetId: 'SL-SYN-001',
    rules: fictionalRules(),
    facilities: [{ id: 'F1', timezone: 'America/New_York' }],
    persons: [{ id: 'E1' }, { id: 'E2' }, { id: 'E3' }],
    identityAliases: [],
    classifications: [
      { personId: 'E1', localRole: 'RN', configuredReportRole: 'RN', effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31' },
      { personId: 'E2', localRole: 'CNA', configuredReportRole: 'CNA', effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31' },
      { personId: 'E3', localRole: 'RN', configuredReportRole: 'RN', effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31' },
    ],
    sourceSelections: [
      { facilityId: 'F1', personId: 'E1', effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31', sourceType: 'PAYROLL' },
      { facilityId: 'F1', personId: 'E2', effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31', sourceType: 'PAYROLL' },
      { facilityId: 'F1', personId: 'E3', effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31', sourceType: 'AGENCY' },
    ],
    schedule: [
      { id: 'S1', facilityId: 'F1', personId: 'E1', date: '2026-10-05', role: 'RN', minutes: 480 },
      { id: 'S2', facilityId: 'F1', personId: 'E2', date: '2026-10-05', role: 'CNA', minutes: 360 },
      { id: 'S3', facilityId: 'F1', personId: 'E3', date: '2026-10-05', role: 'RN', minutes: 240 },
    ],
    payroll: [
      { id: 'P1', facilityId: 'F1', personId: 'E1', date: '2026-10-05', role: 'RN', minutes: 480, status: 'APPROVED' },
      { id: 'P2', facilityId: 'F1', personId: 'E2', date: '2026-10-05', role: 'CNA', minutes: 300, status: 'APPROVED' },
    ],
    agency: [
      { id: 'A1', facilityId: 'F1', personId: 'E3', date: '2026-10-05', role: 'RN', minutes: 240, status: 'APPROVED' },
    ],
    reported: [
      { id: 'R1', facilityId: 'F1', personId: 'E1', date: '2026-10-05', role: 'RN', minutes: 480, sourceReference: 'P1' },
      { id: 'R2', facilityId: 'F1', personId: 'E1', date: '2026-10-05', role: 'RN', minutes: 480, sourceReference: 'P1' },
      { id: 'R3', facilityId: 'F1', personId: 'E2', date: '2026-10-05', role: 'CNA', minutes: 360, sourceReference: 'P2' },
      { id: 'R4', facilityId: 'F1', personId: 'E3', date: '2026-10-05', role: 'CNA', minutes: 240, sourceReference: 'A1' },
    ],
  };
}

/** Corrected report: R2 removed, R3 = 300, R4 role RN. Evidence identical to golden. */
export function correctedFixture() {
  return {
    schemaVersion: 'shiftledger.dataset.v1',
    datasetId: 'SL-SYN-001-CORRECTED',
    rules: fictionalRules(),
    facilities: [{ id: 'F1', timezone: 'America/New_York' }],
    persons: [{ id: 'E1' }, { id: 'E2' }, { id: 'E3' }],
    identityAliases: [],
    classifications: [
      { personId: 'E1', localRole: 'RN', configuredReportRole: 'RN', effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31' },
      { personId: 'E2', localRole: 'CNA', configuredReportRole: 'CNA', effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31' },
      { personId: 'E3', localRole: 'RN', configuredReportRole: 'RN', effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31' },
    ],
    sourceSelections: [
      { facilityId: 'F1', personId: 'E1', effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31', sourceType: 'PAYROLL' },
      { facilityId: 'F1', personId: 'E2', effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31', sourceType: 'PAYROLL' },
      { facilityId: 'F1', personId: 'E3', effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31', sourceType: 'AGENCY' },
    ],
    schedule: [
      { id: 'S1', facilityId: 'F1', personId: 'E1', date: '2026-10-05', role: 'RN', minutes: 480 },
      { id: 'S2', facilityId: 'F1', personId: 'E2', date: '2026-10-05', role: 'CNA', minutes: 360 },
      { id: 'S3', facilityId: 'F1', personId: 'E3', date: '2026-10-05', role: 'RN', minutes: 240 },
    ],
    payroll: [
      { id: 'P1', facilityId: 'F1', personId: 'E1', date: '2026-10-05', role: 'RN', minutes: 480, status: 'APPROVED' },
      { id: 'P2', facilityId: 'F1', personId: 'E2', date: '2026-10-05', role: 'CNA', minutes: 300, status: 'APPROVED' },
    ],
    agency: [
      { id: 'A1', facilityId: 'F1', personId: 'E3', date: '2026-10-05', role: 'RN', minutes: 240, status: 'APPROVED' },
    ],
    reported: [
      { id: 'R1', facilityId: 'F1', personId: 'E1', date: '2026-10-05', role: 'RN', minutes: 480, sourceReference: 'P1' },
      { id: 'R3', facilityId: 'F1', personId: 'E2', date: '2026-10-05', role: 'CNA', minutes: 300, sourceReference: 'P2' },
      { id: 'R4', facilityId: 'F1', personId: 'E3', date: '2026-10-05', role: 'RN', minutes: 240, sourceReference: 'A1' },
    ],
  };
}

/** Split-record variant: P2 -> P2a 120 + P2b 180; R3 -> R3a/P2a 120 + R3b/P2b 180. */
export function splitFixture() {
  return {
    schemaVersion: 'shiftledger.dataset.v1',
    datasetId: 'SL-SYN-001-SPLIT',
    rules: fictionalRules(),
    facilities: [{ id: 'F1', timezone: 'America/New_York' }],
    persons: [{ id: 'E1' }, { id: 'E2' }, { id: 'E3' }],
    identityAliases: [],
    classifications: [
      { personId: 'E1', localRole: 'RN', configuredReportRole: 'RN', effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31' },
      { personId: 'E2', localRole: 'CNA', configuredReportRole: 'CNA', effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31' },
      { personId: 'E3', localRole: 'RN', configuredReportRole: 'RN', effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31' },
    ],
    sourceSelections: [
      { facilityId: 'F1', personId: 'E1', effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31', sourceType: 'PAYROLL' },
      { facilityId: 'F1', personId: 'E2', effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31', sourceType: 'PAYROLL' },
      { facilityId: 'F1', personId: 'E3', effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31', sourceType: 'AGENCY' },
    ],
    schedule: [
      { id: 'S1', facilityId: 'F1', personId: 'E1', date: '2026-10-05', role: 'RN', minutes: 480 },
      { id: 'S2', facilityId: 'F1', personId: 'E2', date: '2026-10-05', role: 'CNA', minutes: 360 },
      { id: 'S3', facilityId: 'F1', personId: 'E3', date: '2026-10-05', role: 'RN', minutes: 240 },
    ],
    payroll: [
      { id: 'P1', facilityId: 'F1', personId: 'E1', date: '2026-10-05', role: 'RN', minutes: 480, status: 'APPROVED' },
      { id: 'P2a', facilityId: 'F1', personId: 'E2', date: '2026-10-05', role: 'CNA', minutes: 120, status: 'APPROVED' },
      { id: 'P2b', facilityId: 'F1', personId: 'E2', date: '2026-10-05', role: 'CNA', minutes: 180, status: 'APPROVED' },
    ],
    agency: [
      { id: 'A1', facilityId: 'F1', personId: 'E3', date: '2026-10-05', role: 'RN', minutes: 240, status: 'APPROVED' },
    ],
    reported: [
      { id: 'R1', facilityId: 'F1', personId: 'E1', date: '2026-10-05', role: 'RN', minutes: 480, sourceReference: 'P1' },
      { id: 'R2', facilityId: 'F1', personId: 'E1', date: '2026-10-05', role: 'RN', minutes: 480, sourceReference: 'P1' },
      { id: 'R3a', facilityId: 'F1', personId: 'E2', date: '2026-10-05', role: 'CNA', minutes: 120, sourceReference: 'P2a' },
      { id: 'R3b', facilityId: 'F1', personId: 'E2', date: '2026-10-05', role: 'CNA', minutes: 180, sourceReference: 'P2b' },
      { id: 'R4', facilityId: 'F1', personId: 'E3', date: '2026-10-05', role: 'CNA', minutes: 240, sourceReference: 'A1' },
    ],
  };
}

/** Day-split overnight variant: E4 works 120 min on 2026-10-06 and 360 min on 2026-10-07. */
export function overnightFixture() {
  return {
    schemaVersion: 'shiftledger.dataset.v1',
    datasetId: 'SL-SYN-002-OVERNIGHT',
    rules: fictionalRules(),
    facilities: [{ id: 'F1', timezone: 'America/New_York' }],
    persons: [{ id: 'E4' }],
    identityAliases: [],
    classifications: [
      { personId: 'E4', localRole: 'CNA', configuredReportRole: 'CNA', effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31' },
    ],
    sourceSelections: [
      { facilityId: 'F1', personId: 'E4', effectiveFrom: '2026-10-01', effectiveTo: '2026-10-31', sourceType: 'PAYROLL' },
    ],
    schedule: [
      { id: 'S4a', facilityId: 'F1', personId: 'E4', date: '2026-10-06', role: 'CNA', minutes: 120 },
      { id: 'S4b', facilityId: 'F1', personId: 'E4', date: '2026-10-07', role: 'CNA', minutes: 360 },
    ],
    payroll: [
      { id: 'P4a', facilityId: 'F1', personId: 'E4', date: '2026-10-06', role: 'CNA', minutes: 120, status: 'APPROVED' },
      { id: 'P4b', facilityId: 'F1', personId: 'E4', date: '2026-10-07', role: 'CNA', minutes: 360, status: 'APPROVED' },
    ],
    agency: [],
    reported: [
      { id: 'R5a', facilityId: 'F1', personId: 'E4', date: '2026-10-06', role: 'CNA', minutes: 120, sourceReference: 'P4a' },
      { id: 'R5b', facilityId: 'F1', personId: 'E4', date: '2026-10-07', role: 'CNA', minutes: 360, sourceReference: 'P4b' },
    ],
  };
}
