declare module "*.tf" { const content: string; export default content; }
declare module "*.yml" { const content: string; export default content; }
declare module "*.cfg" { const content: string; export default content; }
declare module "*.cnf" { const content: string; export default content; }
declare module "*.env" { const content: string; export default content; }
declare module "*/apparmor-local" { const content: string; export default content; }
declare module "*/mysql-agy-lib" { const content: string; export default content; }
declare module "*/mysql-agy-endpoint" { const content: string; export default content; }
declare module "*/mysql-agy-heartbeat" { const content: string; export default content; }
declare module "*/mysql-agy-snapshot" { const content: string; export default content; }
declare module "*/mysql-agy-binlog-archive" { const content: string; export default content; }
declare module "*/mysql-agy-binlog-upload" { const content: string; export default content; }
declare module "*/mysql-agy-restore-check" { const content: string; export default content; }
declare module "*/mysql-agy-health" { const content: string; export default content; }
// package-once-red's tools.ts imports these text resources; the declarations
// let `tsc --noEmit` follow the dependency the same way clickstack's do.
declare module "*.ini" { const content: string; export default content; }
declare module "*/authorized-keys" { const content: string; export default content; }
declare module "*/deploy" { const content: string; export default content; }
declare module "*/once" { const content: string; export default content; }
