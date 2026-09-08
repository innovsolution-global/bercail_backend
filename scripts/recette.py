"""
Recette de l'API Le Bercail — parcours réel, quatre rôles.

Vérifie une instance en fonctionnement de bout en bout : connexion des
quatre rôles, matrice d'autorisation, calcul des prix, refus d'un montant
imposé par le client, commande, idempotence, isolation des données,
cuisine, attribution, GPS, code de remise, encaissement, tableaux de bord,
administration, audit, promotions et recherche.

À exécuter contre une base semée (`npm run seed`), API démarrée :

    python scripts/recette.py

Sans dépendance : bibliothèque standard uniquement. Le script consomme des
connexions ; la limitation de débit peut le bloquer si vous l'enchaînez —
redémarrez l'API entre deux passages, ou attendez la fenêtre.
"""
import json
import time
import urllib.request
import urllib.error

BASE = "http://localhost:3000/api/v1"
CLE = f"recette-{int(time.time())}"  # cle d'idempotence unique par execution
ok = 0
ko = 0


def call(method, path, body=None, token=None, headers=None, expect=None):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


def check(label, status, expected, extra=""):
    global ok, ko
    if status == expected:
        ok += 1
        print(f"  OK   {label}  [{status}] {extra}")
    else:
        ko += 1
        print(f"  ECHEC {label}  attendu {expected}, recu {status} {extra}")


def login(email, password):
    s, b = call("POST", "/auth/login", {"email": email, "password": password})
    assert s == 200, b
    return b["data"]["accessToken"], b["data"]["user"]


print("\n=== 1. CONNEXION DES QUATRE ROLES ===")
ct, cu = login("mariama.diallo@example.gn", "Client@2024")
check("client", 200, 200, f"role={cu['role']} permissions={len(cu['permissions'])}")
dt, du = login("ibrahima.camara@lebercail.gn", "Livreur@2024")
check("livreur", 200, 200, f"role={du['role']} code={du['driver']['driverCode']}")
at, au = login("admin@lebercail.gn", "Admin@2024")
check("admin", 200, 200, f"role={au['role']} permissions={len(au['permissions'])}")
st, su = login("superadmin@lebercail.gn", "SuperAdmin@2024")
check("super admin", 200, 200, f"role={su['role']} permissions={len(su['permissions'])}")
lt, lu = login("admin.carte@lebercail.gn", "Admin@2024")
check("admin restreint", 200, 200, f"permissions={len(lu['permissions'])}")

# Ce que fait l'application livreur au demarrage : se declarer en service.
s, dispo = call("PATCH", "/driver/availability", {"isOnline": True, "isAvailable": True}, token=dt)
check(
    "livreur en service",
    s,
    200,
    f"en ligne={dispo['data']['isOnline']} disponible={dispo['data']['isAvailable']}",
)

print("\n=== 2. MATRICE RBAC ===")
s, _ = call("GET", "/customers", token=ct)
check("client -> /customers", s, 403)
s, _ = call("GET", "/administrators", token=ct)
check("client -> /administrators", s, 403)
s, _ = call("GET", "/dashboard", token=dt)
check("livreur -> /dashboard", s, 403)
s, _ = call("GET", "/deliveries", token=dt)
check("livreur -> /deliveries", s, 403)
s, _ = call("GET", "/administrators", token=at)
check("admin -> /administrators", s, 403)
s, _ = call("GET", "/audit-logs", token=at)
check("admin -> /audit-logs", s, 403)
s, _ = call("GET", "/settings/system", token=at)
check("admin -> /settings/system", s, 403)
s, _ = call("GET", "/administrators", token=st)
check("super admin -> /administrators", s, 200)
s, _ = call("GET", "/audit-logs", token=st)
check("super admin -> /audit-logs", s, 200)
s, _ = call("GET", "/orders", token=at)
check("admin -> /orders", s, 200)
s, _ = call("GET", "/orders", token=lt)
check("admin restreint -> /orders (a ORDERS_READ)", s, 200)
s, _ = call("GET", "/customers", token=lt)
check("admin restreint -> /customers (sans permission)", s, 403)

print("\n=== 3. CARTE (memes routes, vues differentes) ===")
s, pub = call("GET", "/menu-items?limit=100")
check("carte publique", s, 200, f"{pub['meta']['total']} plats disponibles")
s, adm = call("GET", "/menu-items?limit=100", token=at)
check("carte back-office", s, 200, f"{adm['meta']['total']} plats au total")
s, hi = call("GET", "/menu-items/highlights")
check(
    "selection accueil",
    s,
    200,
    f"{len(hi['data']['popular'])} populaires, {len(hi['data']['suggestions'])} suggestions",
)

# Un plat principal : groupe d'accompagnement obligatoire, prix eleve.
item = next(
    i
    for i in pub["data"]
    if any(g["isRequired"] for g in i["optionGroups"]) and i["price"] >= 50000
)
groupe = next(g for g in item["optionGroups"] if g["isRequired"])
# Option payante, pour verifier la prise en compte du supplement.
option = next((o for o in groupe["options"] if o["extraPrice"] > 0), groupe["options"][0])

print("\n=== 4. PANIER ET CALCUL DE PRIX ===")
call("DELETE", "/cart", token=ct)
s, cart = call(
    "POST",
    "/cart/items",
    {"menuItemId": item["id"], "quantity": 2, "optionIds": [option["id"]]},
    token=ct,
)
attendu = (item["price"] + option["extraPrice"]) * 2
check(
    "ajout au panier",
    s,
    201,
    f"({item['price']} + {option['extraPrice']}) x 2 = {attendu}, recu {cart['data']['subtotal']}",
)
check("prix et supplement calcules par le serveur", cart["data"]["subtotal"], attendu)

s, b = call("POST", "/cart/items", {"menuItemId": item["id"], "quantity": 1}, token=ct)
check("option obligatoire manquante refusee", s, 400, b.get("code", ""))

s, b = call(
    "POST",
    "/cart/items",
    {
        "menuItemId": item["id"],
        "quantity": 1,
        "optionIds": ["00000000-0000-0000-0000-000000000000"],
    },
    token=ct,
)
check("option inconnue refusee", s, 400, b.get("code", ""))

print("\n=== 5. REFUS D'UN MONTANT ENVOYE PAR LE CLIENT ===")
s, b = call(
    "POST",
    "/orders",
    {"type": "pickup", "paymentMethod": "cash_on_delivery", "total": 1, "subtotal": 1},
    token=ct,
)
check("total impose par le client", s, 422, b.get("code", ""))

print("\n=== 6. ADRESSE ET COMMANDE ===")
s, addr = call(
    "POST",
    "/addresses",
    {
        "label": "Recette",
        "street": "Rue de la recette",
        "district": "Kaloum",
        "latitude": 9.51,
        "longitude": -13.71,
    },
    token=ct,
)
check("creation adresse", s, 201, f"par defaut={addr['data']['isDefault']}")

s, quote = call("POST", "/orders/quote", {"type": "delivery"}, token=ct)
check(
    "devis",
    s,
    200,
    f"sous-total={quote['data']['subtotal']} livraison={quote['data']['deliveryFee']} total={quote['data']['total']}",
)

s, order = call(
    "POST",
    "/orders",
    {
        "type": "delivery",
        "addressId": addr["data"]["id"],
        "paymentMethod": "cash_on_delivery",
        "note": "Recette automatisee",
    },
    token=ct,
    headers={"Idempotency-Key": CLE},
)
check("creation commande", s, 201, f"ref={order['data']['reference']}")
check("total facture = total du devis", order["data"]["total"], quote["data"]["total"])
oid = order["data"]["id"]

s, replay = call(
    "POST",
    "/orders",
    {
        "type": "delivery",
        "addressId": addr["data"]["id"],
        "paymentMethod": "cash_on_delivery",
        "note": "Recette automatisee",
    },
    token=ct,
    headers={"Idempotency-Key": CLE},
)
check("idempotence : meme cle -> meme commande", replay["data"]["id"], oid, "aucun doublon")

s, c = call("GET", "/cart", token=ct)
check("panier vide apres commande", len(c["data"]["items"]), 0)

print("\n=== 7. ISOLATION DES DONNEES ===")
bt, _ = login("ibrahima.barry@example.gn", "Client@2024")
s, _ = call("GET", f"/orders/{oid}", token=bt)
check("client B -> commande du client A", s, 403)
s, _ = call("GET", f"/orders/{oid}", token=ct)
check("client A -> sa commande", s, 200)
s, _ = call("GET", f"/orders/{oid}", token=at)
check("admin -> la commande", s, 200)

print("\n=== 8. CUISINE (back-office) ===")
for statut in ["confirmed", "preparing", "ready"]:
    s, r = call("PATCH", f"/orders/{oid}/status", {"status": statut}, token=at)
    check(f"passage a {statut}", s, 200, r["data"]["status"] if s == 200 else r.get("code"))

s, b = call("PATCH", f"/orders/{oid}/status", {"status": "pending"}, token=at)
check("retour en arriere refuse", s, 409, b.get("code", ""))

print("\n=== 9. ATTRIBUTION DU LIVREUR ===")
s, drv = call("GET", f"/drivers/assignable?orderId={oid}", token=at)
check("livreurs disponibles", s, 200, f"{len(drv['data'])} candidats")
driver_id = du["driver"]["id"]
s, assigned = call("POST", f"/orders/{oid}/assign", {"driverId": driver_id}, token=at)
check("attribution", s, 200, f"statut commande={assigned['data']['status']}")

s, notifs = call("GET", "/notifications?limit=5", token=ct)
code = None
for n in notifs["data"]:
    if "code de confirmation" in n["body"]:
        import re

        m = re.search(r"(\d{4,8})", n["body"])
        if m:
            code = m.group(1)
        break
check("code de remise recu par le client", bool(code), True, f"code={code}")

print("\n=== 10. PARCOURS DU LIVREUR ===")
s, runs = call("GET", "/driver/deliveries?scope=active", token=dt)
check("courses du livreur", s, 200, f"{len(runs['data'])} course(s)")
run = next(r for r in runs["data"] if r["orderId"] == oid)
did = run["id"]
check("email client absent de la vue livreur", "email" in run["customer"], False)
check("montant a encaisser", run["amountToCollect"], order["data"]["total"])

s, _ = call("GET", f"/driver/deliveries/{did}", token=dt)
check("livreur -> sa course", s, 200)
d2t, _ = login("moussa.bangoura@lebercail.gn", "Livreur@2024")
s, _ = call("GET", f"/driver/deliveries/{did}", token=d2t)
check("livreur B -> course du livreur A", s, 403)

for etape, libelle in [
    ("accept", "acceptation"),
    ("arrived-restaurant", "arrivee restaurant"),
    ("pickup", "recuperation"),
]:
    s, r = call("POST", f"/driver/deliveries/{did}/{etape}", {}, token=dt)
    check(libelle, s, 200, r["data"]["status"] if s == 200 else r.get("code"))

s, o = call("GET", f"/orders/{oid}", token=at)
check("commande passee en livraison", o["data"]["status"], "out_for_delivery")

s, _ = call(
    "POST",
    "/driver/location",
    {"latitude": 9.512, "longitude": -13.708, "accuracy": 8, "speed": 9},
    token=dt,
)
check("position transmise", s, 200)

s, tr = call("GET", f"/orders/{oid}/tracking", token=ct)
pos = tr["data"]["delivery"]["driver"]["position"]
check("client suit son livreur", s, 200, f"lat={pos['latitude']} lon={pos['longitude']}")
s, _ = call("GET", f"/orders/{oid}/tracking", token=bt)
check("client B ne suit pas ce livreur", s, 403)

call("POST", f"/driver/deliveries/{did}/start", {}, token=dt)
call("POST", f"/driver/deliveries/{did}/arrived", {}, token=dt)

print("\n=== 11. CODE DE REMISE (OTP) ===")
s, b = call("POST", f"/driver/deliveries/{did}/complete", {"code": "0000"}, token=dt)
check("mauvais code refuse", s, 400, b.get("code", ""))
s, r = call("POST", f"/driver/deliveries/{did}/complete", {"code": code}, token=dt)
check("bon code accepte", s, 200, r["data"]["status"] if s == 200 else r.get("code"))
s, b = call("POST", f"/driver/deliveries/{did}/complete", {"code": code}, token=dt)
check("rejeu du code refuse", s, 409, b.get("code", ""))

s, final = call("GET", f"/orders/{oid}", token=ct)
check("commande livree", final["data"]["status"], "delivered")
check("paiement encaisse a la livraison", final["data"]["paymentStatus"], "paid")

print("\n=== 12. TABLEAUX DE BORD ET RAPPORTS ===")
s, dash = call("GET", "/dashboard", token=at)
d = dash["data"]
check(
    "tableau de bord admin",
    s,
    200,
    f"CA={d['stats']['revenue']['value']} commandes={d['stats']['orders']['value']} panier={d['stats']['averageBasket']['value']}",
)
check("series temporelles", len(d["series"]) > 0, True, f"{len(d['series'])} points")
check("meilleures ventes", len(d["topProducts"]) > 0, True, f"{len(d['topProducts'])} produits")
s, sdash = call("GET", "/dashboard/super-admin", token=st)
check(
    "tableau de bord super admin",
    s,
    200,
    f"admins={sdash['data']['adminsCount']} sante={sdash['data']['health']['database']} alertes={len(sdash['data']['securityAlerts'])}",
)
s, rep = call("GET", "/reports?period=daily", token=at)
check("rapport", s, 200, f"livraisons OK={rep['data']['delivery']['successRate']}%")

print("\n=== 13. SUPER ADMIN : ADMINISTRATION ===")
s, admins = call("GET", "/administrators", token=st)
check("liste des administrateurs", s, 200, f"{admins['meta']['total']} comptes")
s, perms = call("GET", "/permissions", token=st)
check(
    "catalogue des permissions",
    s,
    200,
    f"{len(perms['data']['permissions'])} permissions, {len(perms['data']['modules'])} modules",
)
admin_id = next(a["id"] for a in admins["data"] if a["email"] == "admin.carte@lebercail.gn")
s, b = call(
    "PATCH",
    f"/administrators/{admin_id}/permissions",
    {"permissions": ["ORDERS_READ", "USERS_PERMISSIONS"]},
    token=st,
)
check("permission non delegable refusee", s, 403, b.get("code", ""))
sa_id = su["id"]
s, b = call("PATCH", f"/administrators/{sa_id}", {"firstName": "Pirate"}, token=st)
check("modification d'un SUPER_ADMIN refusee", s, 403, b.get("code", ""))

print("\n=== 14. JOURNAL D'AUDIT ===")
s, logs = call("GET", "/audit-logs?limit=100", token=st)
check("journal accessible", s, 200, f"{logs['meta']['total']} entrees")
actions = {log["action"] for log in logs["data"]}
for attendu in ["ORDER_CREATE", "DELIVERY_ASSIGN", "DELIVERY_COMPLETED", "ORDER_STATUS_UPDATE"]:
    check(f"action auditee {attendu}", attendu in actions, True)

print("\n=== 15. PROMOTIONS ===")
s, promo = call("GET", "/promotions/check/BIENVENUE10", token=ct)
check("code promo valide", s, 200, f"{promo['data']['value']}% max {promo['data']['maxDiscount']}")
s, b = call("GET", "/promotions/check/INEXISTANT", token=ct)
check("code inconnu refuse", s, 400, b.get("code", ""))

print("\n=== 16. RECHERCHE ===")
s, res = call("GET", "/search?q=poulet", token=ct)
check("recherche client (carte)", s, 200, f"{len(res['data']['menuItems'])} plats, 0 client")
check("client ne voit aucun autre client", len(res["data"]["customers"]), 0)
s, res = call("GET", "/search?q=Diallo", token=at)
check("recherche admin", s, 200, f"{len(res['data']['customers'])} clients trouves")

print(f"\n{'=' * 62}")
print(f"  RESULTAT : {ok} verifications reussies, {ko} echecs")
print(f"{'=' * 62}\n")
