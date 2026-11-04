import json, hashlib, sqlite3
from pathlib import Path
from collections import Counter
p=Path('orders.ndjson'); original=p.read_bytes(); digest=hashlib.sha256(original).hexdigest()
rows=[json.loads(s) for s in original.splitlines() if s.strip()]
regions=Counter(); units=Counter(); count=0; total=0
for o in rows:
 if o['status']!='completed': continue
 count+=1
 assert isinstance(o['discount_cents'],int)
 for i in o['items']:
  assert isinstance(i['qty'],int) and isinstance(i['unit_cents'],int)
  units[i['sku']]+=i['qty']
 net=sum(i['qty']*i['unit_cents'] for i in o['items'])-o['discount_cents']
 total+=net; regions[o['region']]+=net
leaders=sorted(units,key=lambda s:(-units[s],s))
assert leaders, 'No completed SKU data'
assert len(leaders)==1 or units[leaders[0]]>units[leaders[1]], 'Top SKU tie requires explicit handling'
result={'completed_orders':count,'net_revenue_cents':total,'revenue_by_region':dict(sorted(regions.items())),'top_sku_by_units':{'sku':leaders[0],'units':units[leaders[0]]}}
# Independent SQL reconciliation using order and item tables, including excluded statuses.
c=sqlite3.connect(':memory:')
c.executescript('CREATE TABLE orders (id INTEGER,status TEXT,region TEXT,discount INTEGER); CREATE TABLE items (oid INTEGER,sku TEXT,qty INTEGER,price INTEGER);')
for idx,o in enumerate(rows):
 c.execute('INSERT INTO orders VALUES (?,?,?,?)',(idx,o['status'],o['region'],o['discount_cents']))
 c.executemany('INSERT INTO items VALUES (?,?,?,?)',[(idx,i['sku'],i['qty'],i['unit_cents']) for i in o['items']])
cte="WITH net AS (SELECT o.id,o.region,COALESCE(SUM(i.qty*i.price),0)-o.discount AS revenue FROM orders o LEFT JOIN items i ON o.id=i.oid WHERE o.status='completed' GROUP BY o.id) "
assert c.execute(cte+'SELECT COUNT(*),SUM(revenue) FROM net').fetchone()==(count,total)
assert dict(c.execute(cte+'SELECT region,SUM(revenue) FROM net GROUP BY region'))==dict(regions)
assert c.execute("SELECT i.sku,SUM(i.qty) FROM items i JOIN orders o ON o.id=i.oid WHERE o.status='completed' GROUP BY i.sku ORDER BY SUM(i.qty) DESC,i.sku LIMIT 1").fetchone()==(leaders[0],units[leaders[0]])
assert sum(regions.values())==total
out=Path('analysis.json'); out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
assert json.loads(out.read_text())==result
assert hashlib.sha256(p.read_bytes()).hexdigest()==digest
print(json.dumps(result,ensure_ascii=False))
print(f'Verified all {len(rows)} records with independent SQL; output re-read and source hash unchanged.')
