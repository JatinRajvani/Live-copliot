import { randomBytes } from 'crypto';

export const generateJWTSecret = () => {
  return randomBytes(64).toString('base64');
};

// usage
console.log(generateJWTSecret());