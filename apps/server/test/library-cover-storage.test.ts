import { Database } from 'bun:sqlite';
import { Effect } from 'effect';
import { libraryCoverRepositoryContract } from './library-cover-repository-contract.js';
const db=new Database(':memory:');
const migration=await Bun.file(new URL('../migrations/0008_library_covers.sql',import.meta.url)).text().catch(()=> '');
db.exec('PRAGMA foreign_keys=ON; CREATE TABLE virtual_libraries(id TEXT PRIMARY KEY,name TEXT,media_type TEXT,enabled INTEGER); CREATE TABLE library_sources(virtual_library_id TEXT,server_id TEXT,source_library_id TEXT,enabled INTEGER,source_order INTEGER); CREATE TABLE upstream_servers(id TEXT,generation INTEGER,enabled INTEGER,deleted_at_ms INTEGER,health TEXT,verified_base_url TEXT);');
if(migration) db.exec(migration);
libraryCoverRepositoryContract({unsafe:<A extends object>(s:string,p:ReadonlyArray<unknown>=[])=>Effect.sync(()=>db.query(s).all(...p as never[]) as A[]),batch:c=>Effect.sync(()=>db.transaction(()=>c.forEach(x=>db.query(x.statement).run(...x.params as never[])))())},async()=>{ db.exec('DELETE FROM virtual_libraries'); db.run("INSERT INTO virtual_libraries VALUES ('cover-library','Movies','movies',1)"); });
