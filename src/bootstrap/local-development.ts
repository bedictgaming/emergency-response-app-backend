// Synchronous setup runs before app/config imports; no marker means no local override.
import dotenv from 'dotenv';
import { configureLocalDevelopment } from '@/lib/local-development-config';
dotenv.config({ quiet: true });
configureLocalDevelopment();
