export function citizenPresenceEnabled() {
  return process.env.CITIZEN_PRESENCE_ENABLED === 'true';
}

export function validateCitizenPresenceConfiguration(environment: NodeJS.ProcessEnv) {
  if (environment.CITIZEN_PRESENCE_ENABLED !== undefined && !['true', 'false'].includes(environment.CITIZEN_PRESENCE_ENABLED))
    throw new Error('Invalid citizen presence configuration');
  if (environment.CITIZEN_PRESENCE_ENABLED === 'true' && environment.NODE_ENV === 'production'
    && environment.CITIZEN_PRESENCE_TOPOLOGY !== 'single-process')
    throw new Error('Citizen presence requires an explicitly verified single-process topology');
}
