-- ===========================================================================
--  Le journal ignore les écritures qui ne changent rien.
--
--  Certaines routines réécrivent des lignes à l'identique — la
--  synchronisation du catalogue de permissions au démarrage en écrit 55 à
--  chaque fois. Sans ce filtre, chaque redémarrage enverrait 55 écritures
--  inutiles sur une liaison qu'on cherche justement à ménager.
-- ===========================================================================

CREATE OR REPLACE FUNCTION sync_record_change() RETURNS trigger AS $$
DECLARE
  payload   jsonb;
  operation "SyncOperation";
  entity_id text;
  node      "SyncNode";
BEGIN
  -- Garde anti-écho : une écriture reçue du pair ne repart pas vers lui.
  IF current_setting('app.sync_apply', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    payload := to_jsonb(OLD);
    operation := 'DELETE';
    entity_id := OLD.id;
  ELSIF TG_OP = 'INSERT' THEN
    payload := to_jsonb(NEW);
    operation := 'CREATE';
    entity_id := NEW.id;
  ELSE
    -- Une mise à jour qui laisse la ligne identique n'a rien à transmettre.
    -- `updatedAt` change à chaque écriture Prisma : on l'écarte de la
    -- comparaison, sans quoi le filtre ne servirait jamais.
    IF (to_jsonb(OLD) - 'updatedAt') = (to_jsonb(NEW) - 'updatedAt') THEN
      RETURN NEW;
    END IF;

    payload := to_jsonb(NEW);
    operation := 'UPDATE';
    entity_id := NEW.id;
  END IF;

  node := COALESCE(NULLIF(current_setting('app.sync_node', true), ''), 'LOCAL')::"SyncNode";

  INSERT INTO sync_outbox ("id", "origin", "entity", "entityId", "operation", "payload", "occurredAt", "status", "attempts", "createdAt")
  VALUES (gen_random_uuid()::text, node, TG_ARGV[0], entity_id, operation, payload, clock_timestamp(), 'PENDING', 0, clock_timestamp());

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Les écritures déjà journalisées avant ce filtre n'ont pas à partir : elles
-- décrivent l'état actuel, que le premier échange transmettra de toute façon.
DELETE FROM sync_outbox WHERE "entity" IN ('Permission', 'RolePermission') AND "status" = 'PENDING';
