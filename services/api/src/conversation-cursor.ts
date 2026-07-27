// PostgreSQL's uuid type accepts all 128-bit UUID values, including imported
// identifiers without RFC version/variant bits.
const POSTGRES_UUID_PATTERN=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function isPostgresUuid(value:string):boolean{
  return POSTGRES_UUID_PATTERN.test(value);
}
