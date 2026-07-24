ALTER TABLE account_task_settings
  ADD COLUMN IF NOT EXISTS timezone text,
  ADD COLUMN IF NOT EXISTS holiday_definitions jsonb;

UPDATE account_task_settings task_settings
SET timezone=COALESCE(NULLIF(task_settings.timezone,''),agent_settings.timezone,'UTC')
FROM account_agent_settings agent_settings
WHERE agent_settings.account_id=task_settings.account_id
  AND task_settings.timezone IS NULL;

UPDATE account_task_settings
SET timezone='UTC'
WHERE timezone IS NULL;

UPDATE account_task_settings
SET holiday_definitions='[
  {"id":"new_year","name":"新年","month":1,"day":1},
  {"id":"valentines","name":"情人节","month":2,"day":14},
  {"id":"halloween","name":"万圣节","month":10,"day":31},
  {"id":"christmas","name":"圣诞节","month":12,"day":25}
]'::jsonb
WHERE holiday_definitions IS NULL;

ALTER TABLE account_task_settings
  ALTER COLUMN timezone SET DEFAULT 'UTC',
  ALTER COLUMN timezone SET NOT NULL,
  ALTER COLUMN holiday_definitions SET DEFAULT '[
    {"id":"new_year","name":"新年","month":1,"day":1},
    {"id":"valentines","name":"情人节","month":2,"day":14},
    {"id":"halloween","name":"万圣节","month":10,"day":31},
    {"id":"christmas","name":"圣诞节","month":12,"day":25}
  ]'::jsonb,
  ALTER COLUMN holiday_definitions SET NOT NULL;
