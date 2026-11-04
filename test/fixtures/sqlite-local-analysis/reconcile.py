import csv,json,hashlib,os,sqlite3
from pathlib import Path
from collections import defaultdict
names=['orders.csv','items.csv','refunds.csv','customers.csv']
before={n:hashlib.sha256(Path(n).read_bytes()).hexdigest() for n in names}
data={n:list(csv.DictReader(open(n,newline='',encoding='utf-8-sig'))) for n in names}
orders={r['order_id']:r for r in data['orders.csv'] if r['status']=='completed'}
assert len({r['order_id'] for r in data['orders.csv']})==len(data['orders.csv'])
customers={r['customer_id']:r for r in data['customers.csv']}
assert len(customers)==len(data['customers.csv'])
gross=defaultdict(int); refunds=defaultdict(int); seen={}; duplicates=0
for r in data['items.csv']:
    if r['order_id'] in orders: gross[r['order_id']]+=int(r['qty'])*int(r['unit_cents'])
for r in data['refunds.csv']:
    rid=r['refund_id']
    if rid in seen:
        assert seen[rid]==r, 'Conflicting duplicate refund'
        duplicates+=1
        continue
    seen[rid]=r
    if r['order_id'] in orders: refunds[r['order_id']]+=int(r['amount_cents'])
regions=defaultdict(int)
for oid,o in orders.items():
    region=customers.get(o['customer_id'],{}).get('region','').strip() or 'unknown'
    regions[region]+=gross[oid]-refunds[oid]
result=dict(completed_orders=len(orders),gross_cents=sum(gross.values()),refund_cents=sum(refunds.values()),net_cents=sum(gross.values())-sum(refunds.values()),revenue_by_region=dict(sorted(regions.items())),unmatched_customers=len({o['customer_id'] for o in orders.values() if o['customer_id'] not in customers}),duplicate_refunds=duplicates)
# Independently verify with SQL, aggregating child tables before joining.
c=sqlite3.connect(':memory:')
for name,rows in data.items():
    table=name[:-4]; cols=list(rows[0]); c.execute(f'CREATE TABLE {table} ({",".join(cols)})')
    c.executemany(f'INSERT INTO {table} VALUES ({",".join("?" for _ in cols)})',[[r[k] for k in cols] for r in rows])
query='''WITH g AS (SELECT order_id,SUM(qty*unit_cents) amount FROM items GROUP BY order_id), r AS (SELECT order_id,SUM(amount_cents) amount FROM (SELECT DISTINCT refund_id,order_id,amount_cents FROM refunds) GROUP BY order_id) SELECT o.order_id,o.customer_id,COALESCE(NULLIF(TRIM(c.region),''),'unknown'),COALESCE(g.amount,0),COALESCE(r.amount,0),c.customer_id IS NULL FROM orders o LEFT JOIN g USING(order_id) LEFT JOIN r USING(order_id) LEFT JOIN customers c USING(customer_id) WHERE o.status='completed' '''
rows=c.execute(query).fetchall(); checkregions=defaultdict(int)
for oid,cid,region,g,r,missing in rows: checkregions[region]+=g-r
assert len(rows)==result['completed_orders']
assert sum(r[3] for r in rows)==result['gross_cents']
assert sum(r[4] for r in rows)==result['refund_cents']
assert dict(checkregions)==result['revenue_by_region']
assert len({r[1] for r in rows if r[5]})==result['unmatched_customers']
assert c.execute('SELECT COUNT(*)-COUNT(DISTINCT refund_id) FROM refunds').fetchone()[0]==duplicates
assert sum(regions.values())==result['net_cents']
assert before=={n:hashlib.sha256(Path(n).read_bytes()).hexdigest() for n in names}
out=Path(os.environ.get('ORKAS_OUTPUT_DIR','.'))/'reconciliation.json'; out.parent.mkdir(parents=True,exist_ok=True)
out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
assert json.loads(out.read_text())==result
print(str(out));print(json.dumps(result,ensure_ascii=False));print('PASS: independent SQL reconciliation; regional totals; output round-trip; all four input hashes unchanged.')
