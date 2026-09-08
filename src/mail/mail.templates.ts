import type { MailMessage } from './mail.service';

/**
 * Gabarits d'e-mails.
 *
 * Volontairement en HTML inline et sans image : les clients de messagerie
 * ignorent les feuilles de styles externes, et une image bloquée ne doit pas
 * emporter le message. Chaque gabarit fournit aussi une version texte, seule
 * lisible sur les clients qui refusent le HTML.
 */

const BRAND = '#E07B23';
const INK = '#1F1A17';
const MUTED = '#6B615A';

const FONT = 'Segoe UI,Roboto,Helvetica,Arial,sans-serif';

/**
 * Ossature du message.
 *
 * Tout est en tables à **une seule colonne** : sur un téléphone, deux
 * colonnes côte à côte se chevauchent, et les media queries ne sont pas
 * fiables (Gmail Android les ignore selon les cas). Une colonne unique se
 * comporte identiquement de 320 px à un écran de bureau, sans condition.
 *
 * Les marges sont volontairement modestes : 20 px de chaque côté sur un
 * écran de 360 px, c'est déjà un neuvième de la largeur perdu.
 */
function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light only" />
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#F2E9DC;font-family:${FONT};color:${INK};-webkit-text-size-adjust:100%">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F2E9DC">
    <tr><td align="center" style="padding:16px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#FFFFFF;border-radius:14px;overflow:hidden">
        <tr><td style="background:${BRAND};padding:18px 20px">
          <span style="color:#FFFFFF;font-size:17px;font-weight:700">Les Saveurs du Bercail</span><br />
          <span style="color:#FFEFE0;font-size:11px;letter-spacing:.12em;text-transform:uppercase">Back-office</span>
        </td></tr>
        <tr><td style="padding:22px 20px">
          <h1 style="margin:0 0 12px;font-size:19px;line-height:1.3;color:${INK}">${title}</h1>
          ${body}
        </td></tr>
        <tr><td style="padding:14px 20px;background:#FAF6F0;color:${MUTED};font-size:11px;line-height:1.5">
          Cet e-mail vous est adressé parce qu'un compte a été ouvert à votre nom.
          Si vous n'êtes pas concerné, ignorez-le et prévenez votre administrateur.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

/**
 * Une ligne « libellé au-dessus, valeur en dessous ».
 *
 * L'empilement est ce qui rend le bloc lisible sur téléphone : côte à côte,
 * « Mot de passe provisoire » se brisait sur trois lignes pendant que la
 * valeur restait collée à droite.
 */
function stackedRow(label: string, value: string, monospace = false): string {
  const valueStyle = monospace
    ? `font-family:Consolas,Menlo,Courier New,monospace;font-size:17px;font-weight:700;letter-spacing:.02em`
    : `font-size:15px;font-weight:600`;

  return `<tr><td style="padding:10px 14px">
    <div style="font-size:12px;color:${MUTED};text-transform:uppercase;letter-spacing:.08em">${label}</div>
    <div style="margin-top:3px;color:${INK};word-break:break-all;${valueStyle}">${value}</div>
  </td></tr>`;
}

/**
 * Gmail transforme d'office une adresse en lien bleu souligné. On pose le
 * nôtre d'abord, ce qui neutralise cette détection et garde la teinte du
 * message.
 */
function plainEmail(address: string): string {
  return `<a href="mailto:${address}" style="color:${INK};text-decoration:none">${address}</a>`;
}

/** Compte créé avec un mot de passe provisoire, à changer à la première connexion. */
export function accountCreatedWithPassword(input: {
  to: string;
  fullName: string;
  password: string;
  loginUrl: string;
  /** « administrateur » ou « livreur ». */
  role: string;
}): MailMessage {
  const text = [
    `Bonjour ${input.fullName},`,
    '',
    `Un compte ${input.role} vient d'être ouvert à votre nom sur le back-office des Saveurs du Bercail.`,
    '',
    `Adresse de connexion : ${input.loginUrl}`,
    `Identifiant : ${input.to}`,
    `Mot de passe provisoire : ${input.password}`,
    '',
    "Ce mot de passe est provisoire : il vous sera demandé d'en choisir un autre dès votre première connexion.",
    'Ne le communiquez à personne.',
  ].join('\n');

  const html = layout(
    `Bienvenue, ${input.fullName}`,
    `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${MUTED}">
       Un compte ${input.role} vient d'être ouvert à votre nom sur le back-office.
       Voici vos accès&nbsp;:
     </p>
     <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FAF6F0;border-radius:10px">
       ${stackedRow('Identifiant', plainEmail(input.to))}
       ${stackedRow('Mot de passe provisoire', input.password, true)}
     </table>
     <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px">
       <tr><td style="background:${BRAND};border-radius:8px">
         <a href="${input.loginUrl}" style="display:block;color:#FFFFFF;text-decoration:none;padding:12px 22px;font-size:15px;font-weight:600">
           Se connecter
         </a>
       </td></tr>
     </table>
     <p style="margin:18px 0 0;font-size:12px;line-height:1.6;color:${MUTED}">
       Ce mot de passe est <strong>provisoire</strong>&nbsp;: il vous sera demandé d'en choisir
       un autre dès votre première connexion. Ne le communiquez à personne.
     </p>`,
  );

  return {
    to: input.to,
    subject: 'Vos accès au back-office — Les Saveurs du Bercail',
    text,
    html,
  };
}

/** Compte créé en attente : le titulaire choisit lui-même son mot de passe. */
export function accountCreatedWithActivationLink(input: {
  to: string;
  fullName: string;
  activationUrl: string;
  expiresInHours: number;
  role: string;
}): MailMessage {
  const text = [
    `Bonjour ${input.fullName},`,
    '',
    `Un compte ${input.role} vient d'être ouvert à votre nom sur le back-office des Saveurs du Bercail.`,
    '',
    'Choisissez votre mot de passe en ouvrant ce lien :',
    input.activationUrl,
    '',
    `Ce lien expire dans ${input.expiresInHours} heures et ne peut servir qu'une fois.`,
  ].join('\n');

  const html = layout(
    `Bienvenue, ${input.fullName}`,
    `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${MUTED}">
       Un compte ${input.role} vient d'être ouvert à votre nom. Il ne reste qu'à choisir
       votre mot de passe&nbsp;:
     </p>
     <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FAF6F0;border-radius:10px">
       ${stackedRow('Identifiant', plainEmail(input.to))}
     </table>
     <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px">
       <tr><td style="background:${BRAND};border-radius:8px">
         <a href="${input.activationUrl}" style="display:block;color:#FFFFFF;text-decoration:none;padding:12px 22px;font-size:15px;font-weight:600">
           Activer mon compte
         </a>
       </td></tr>
     </table>
     <p style="margin:18px 0 0;font-size:12px;line-height:1.6;color:${MUTED}">
       Ce lien expire dans ${input.expiresInHours} heures et ne peut servir qu'une fois.
       S'il ne fonctionne plus, demandez-en un nouveau à votre administrateur.
     </p>
     <p style="margin:12px 0 0;font-size:11px;line-height:1.5;color:${MUTED};word-break:break-all">
       Si le bouton ne fonctionne pas, copiez cette adresse dans votre navigateur&nbsp;:<br />
       <span style="color:${INK}">${input.activationUrl}</span>
     </p>`,
  );

  return {
    to: input.to,
    subject: 'Activez votre compte — Les Saveurs du Bercail',
    text,
    html,
  };
}
