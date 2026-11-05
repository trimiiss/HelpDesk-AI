import { MemoryEventBus } from '../src/index.js';
import { eventBusContract } from './contract.js';

eventBusContract('in-memory', async () => {
  const bus = new MemoryEventBus();
  return {
    bus,
    publishRaw: async (subject, payload) => bus.publishRaw(subject, payload),
    async waitForDeadLetter(match) {
      const deadline = Date.now() + 5000;
      for (;;) {
        const found = bus.deadLetters.find((letter) => letter.subject.includes(match));
        if (found) return found;
        if (Date.now() > deadline) throw new Error('no dead letter arrived');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    cleanup: () => bus.close(),
  };
});
