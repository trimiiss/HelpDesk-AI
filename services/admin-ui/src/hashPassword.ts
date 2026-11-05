import { hashPassword } from './auth.js';

const password = process.argv[2];

if (!password || password.length < 12) {
  console.error('Usage: npm run admin:hash -- "a password of at least 12 characters"');
  process.exit(1);
}

console.log(await hashPassword(password));
