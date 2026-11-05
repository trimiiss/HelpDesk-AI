import { createLogger } from '@helpdesk/shared';
import { loadBusinessConfig } from './business.js';
import { createCallControl } from './callControl.js';
import { loadConfig } from './config.js';
import { buildInstructions } from './prompt.js';
import { createRealtimeConnector } from './realtime.js';
import { buildServer } from './server.js';
import { buildSessionUpdate } from './session.js';

const config = loadConfig();
const log = createLogger('call-gateway', config.LOG_LEVEL);
const business = loadBusinessConfig(config.BUSINESS_CONFIG_PATH);
const transferAvailable = config.TRANSFER_NUMBER !== undefined;

if (!transferAvailable) {
  log.warn('TRANSFER_NUMBER is not set: transfers are off and a failed call will hang up');
}

const { app, mediaStream } = buildServer({
  config,
  log,
  sessionUpdate: buildSessionUpdate(config, buildInstructions(business, { transferAvailable })),
  connectRealtime: createRealtimeConnector({
    url: config.OPENAI_REALTIME_URL,
    model: config.REALTIME_MODEL,
    apiKey: config.OPENAI_API_KEY,
    log,
  }),
  control: createCallControl({
    accountSid: config.TWILIO_ACCOUNT_SID,
    authToken: config.TWILIO_AUTH_TOKEN,
    transferNumber: config.TRANSFER_NUMBER,
  }),
});

const shutdown = async (signal: string): Promise<void> => {
  log.info({ signal, activeCalls: mediaStream.activeCalls() }, 'shutting down');
  mediaStream.shutdown();
  await app.close();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: '0.0.0.0', port: config.PORT });
log.info(
  { port: config.PORT, model: config.REALTIME_MODEL, publicUrl: config.PUBLIC_BASE_URL },
  'call-gateway listening',
);
