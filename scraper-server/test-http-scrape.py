import urllib.request, re, json, ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

url = 'https://www.era.be/nl/te-koop'
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
    html = resp.read().decode('utf-8', errors='ignore')
    print(f"Status: {resp.status}, Length: {len(html)}")
    
    json_ld = re.findall(r'<script type="application/ld\+json">(.*?)</script>', html, re.DOTALL)
    print(f"JSON-LD blocks: {len(json_ld)}")
    
    listings = []
    for block in json_ld:
        try:
            data = json.loads(block.strip())
            if data.get("@type") == "RealEstateListing":
                listings.append(data)
        except:
            pass
    
    print(f"RealEstateListings: {len(listings)}")
    if listings:
        print(json.dumps(listings[0], indent=2, ensure_ascii=False)[:600])
    
    # Also look for URL patterns
    links = re.findall(r'href="(/nl/te-koop/[^"]+)"', html)
    print(f"Detail page links: {len(links)}")
    for l in set(links)[:5]:
        print(f"  {l}")
