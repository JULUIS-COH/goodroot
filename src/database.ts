import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const databasePath = resolve(process.env.DATABASE_PATH ?? "data/goodroot.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });

export const database = new DatabaseSync(databasePath);
database.exec("PRAGMA foreign_keys = ON");
database.exec("PRAGMA journal_mode = WAL");
database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
const appliedMigrations = new Set(
  (database.prepare("SELECT id FROM schema_migrations").all() as { id: string }[]).map((row) => row.id),
);
const migrationDirectory = resolve(process.cwd(), "src/migrations");
for (const migrationName of ["001_core.sql", "002_campaign_creation.sql"]) {
  if (appliedMigrations.has(migrationName)) continue;
  const migration = readFileSync(resolve(migrationDirectory, migrationName), "utf8");
  database.exec("BEGIN IMMEDIATE");
  try {
    if (migrationName === "002_campaign_creation.sql") {
      const campaignColumns = new Set(
        (database.prepare("PRAGMA table_info(campaigns)").all() as { name: string }[]).map((column) => column.name),
      );
      for (const statement of migration.split(";").map((part) => part.trim()).filter(Boolean)) {
        const column = statement.match(/ALTER TABLE campaigns ADD COLUMN (\w+)/)?.[1];
        if (!column || !campaignColumns.has(column)) database.exec(statement);
      }
    } else {
      database.exec(migration);
    }
    database.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(migrationName, new Date().toISOString());
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
const userColumns = database.prepare("PRAGMA table_info(users)").all() as { name: string }[];
if (!userColumns.some((column) => column.name === "stripe_payout_ready")) {
  database.exec("ALTER TABLE users ADD COLUMN stripe_payout_ready INTEGER NOT NULL DEFAULT 0");
}
const campaignColumns = database.prepare("PRAGMA table_info(campaigns)").all() as { name: string }[];
const campaignMigrations: Record<string, string> = {
  beneficiary_type: "ALTER TABLE campaigns ADD COLUMN beneficiary_type TEXT NOT NULL DEFAULT 'self'",
  beneficiary_name: "ALTER TABLE campaigns ADD COLUMN beneficiary_name TEXT NOT NULL DEFAULT ''",
  thank_you_note: "ALTER TABLE campaigns ADD COLUMN thank_you_note TEXT NOT NULL DEFAULT ''",
  draft: "ALTER TABLE campaigns ADD COLUMN draft INTEGER NOT NULL DEFAULT 0",
};
for (const [column, migration] of Object.entries(campaignMigrations)) {
  if (!campaignColumns.some((item) => item.name === column)) database.exec(migration);
}

interface SeedCampaign {
  id: string;
  category: string;
  title: string;
  organizer: string;
  story: string;
  image: string;
  goal: number;
  raised: number;
  supporters: number;
  location: string;
}

const seedCampaigns: SeedCampaign[] = [
  {
    id: "garden",
    category: "Community",
    title: "A neighborhood garden for everyone",
    organizer: "Mina and the Eastwood neighbors",
    story: "Help turn a quiet, forgotten corner into a shared garden where neighbors can grow fresh food, meet one another, and learn together.",
    image: "https://images.unsplash.com/photo-1416879595882-3373a0480b5b?auto=format&fit=crop&w=960&q=85",
    goal: 8500,
    raised: 6270,
    supporters: 84,
    location: "Austin, Texas",
  },
  {
    id: "studio",
    category: "Education",
    title: "A little room for big ideas",
    organizer: "Samira's after-school art club",
    story: "We’re collecting the supplies and furniture our young artists need to make a welcoming, creative studio of their own.",
    image: "https://images.unsplash.com/photo-1513364776144-60967b0f800f?auto=format&fit=crop&w=960&q=85",
    goal: 4200,
    raised: 2870,
    supporters: 56,
    location: "Chicago, Illinois",
  },
  {
    id: "wildlife",
    category: "Animals",
    title: "A safe place for the small and wild",
    organizer: "The Willow Lane Wildlife Crew",
    story: "Help us create a sheltered recovery space and stock it with the everyday essentials our local wildlife rescue depends on.",
    image: "https://images.unsplash.com/photo-1459262838948-3e2de6c1ec80?auto=format&fit=crop&w=960&q=85",
    goal: 6000,
    raised: 4515,
    supporters: 72,
    location: "Seattle, Washington",
  },
  {
    id: "clinic",
    category: "Medical",
    title: "A softer landing after a hard diagnosis",
    organizer: "Friends of the Carter family",
    story: "Friends are coming together to help the Carters with travel and day-to-day expenses while they focus on being together.",
    image: "https://images.unsplash.com/photo-1511895426328-dc8714191300?auto=format&fit=crop&w=960&q=85",
    goal: 12000,
    raised: 9360,
    supporters: 113,
    location: "Denver, Colorado",
  },
  {
    id: "river",
    category: "Environment",
    title: "Bring our riverside path back to life",
    organizer: "The Riverside Neighbourhood Group",
    story: "A community clean-up, some native plants, and a little help from our neighbors can make this shared space bloom again.",
    image: "https://images.unsplash.com/photo-1470770841072-f978cf4d019e?auto=format&fit=crop&w=960&q=85",
    goal: 3500,
    raised: 1890,
    supporters: 39,
    location: "Portland, Oregon",
  },
  {
    id: "music",
    category: "Community",
    title: "Keep the Saturday music circle playing",
    organizer: "Nia and the Saturday Music Circle",
    story: "Our free weekly music meet-up is a place for all ages. Help us replace a few tired instruments and keep the circle open to everyone.",
    image: "https://images.unsplash.com/photo-1516280440614-37939bbacd81?auto=format&fit=crop&w=960&q=85",
    goal: 2800,
    raised: 1625,
    supporters: 31,
    location: "Nashville, Tennessee",
  },
];

const seedCampaign = database.prepare(`
  INSERT INTO campaigns
    (id, category, title, organizer, story, image, goal, seed_raised, seed_supporters, location, featured, published, created_at, updated_at)
  VALUES
    (@id, @category, @title, @organizer, @story, @image, @goal, @raised, @supporters, @location, 1, 1, @now, @now)
  ON CONFLICT(id) DO UPDATE SET location = excluded.location
  WHERE campaigns.owner_id IS NULL
`);
for (const campaign of seedCampaigns) {
  seedCampaign.run({ ...campaign, now: new Date().toISOString() });
}
