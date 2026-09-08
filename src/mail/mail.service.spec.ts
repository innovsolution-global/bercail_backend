import { ConfigService } from '@nestjs/config';
import { MailService } from './mail.service';
import {
  accountCreatedWithActivationLink,
  accountCreatedWithPassword,
} from './mail.templates';

/**
 * L'envoi des identifiants conditionne la création d'un compte : un échec
 * doit **lever**, jamais passer inaperçu. Ces tests décrivent les trois
 * situations du service — non configuré, pilote `noop`, pilote `smtp` — sans
 * jamais toucher à un vrai relais.
 */

function configFrom(values: Record<string, unknown>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

const message = {
  to: 'nouvel.admin@lebercail.gn',
  subject: 'Vos accès',
  text: 'mot de passe : secret',
  html: '<p>mot de passe : secret</p>',
};

describe('MailService', () => {
  it('journalise sans expédier avec le pilote noop, et le signale', async () => {
    const service = new MailService(configFrom({ 'mail.driver': 'noop' }));
    // `false` : rien n'est parti. L'appelant doit afficher les accès plutôt
    // que d'annoncer un envoi qui n'a pas eu lieu.
    await expect(service.send(message)).resolves.toBe(false);
    await expect(service.verify()).resolves.toBe(true);
  });

  it('refuse tout envoi si le pilote smtp est demandé sans identifiants', async () => {
    // Le repli silencieux sur `noop` serait le pire des comportements : il
    // créerait des comptes dont personne ne recevrait jamais le mot de passe.
    const service = new MailService(
      configFrom({ 'mail.driver': 'smtp', 'mail.user': 'a@b.c', 'mail.password': '' }),
    );

    await expect(service.verify()).resolves.toBe(false);
    await expect(service.send(message)).rejects.toMatchObject({
      // 422 : la création du compte appelante remonte l'erreur telle quelle.
      status: 422,
    });
  });

  it('propage l’échec du relais plutôt que de l’avaler', async () => {
    const service = new MailService(
      configFrom({
        'mail.driver': 'smtp',
        'mail.host': 'smtp.invalide.test',
        'mail.port': 587,
        'mail.user': 'a@b.c',
        'mail.password': 'app-password',
      }),
    );

    // On neutralise le transport : aucune connexion réseau dans les tests.
    (service as unknown as { transporter: { sendMail: () => Promise<never> } }).transporter = {
      sendMail: () => Promise.reject(new Error('EAUTH')),
    };

    await expect(service.send(message)).rejects.toMatchObject({ status: 422 });
  });
});

describe('gabarits d’e-mail', () => {
  it('porte le mot de passe dans les deux versions du message', () => {
    const mail = accountCreatedWithPassword({
      to: 'fatoumata@lebercail.gn',
      fullName: 'Fatoumata Sylla',
      password: 'Kf3mPq7xW2!',
      loginUrl: 'http://localhost:5173/login',
      role: 'administrateur',
    });

    expect(mail.to).toBe('fatoumata@lebercail.gn');
    // La version texte est la seule lisible sur un client qui refuse le HTML.
    expect(mail.text).toContain('Kf3mPq7xW2!');
    expect(mail.html).toContain('Kf3mPq7xW2!');
    expect(mail.html).toContain('http://localhost:5173/login');
  });

  it('reste sur une seule colonne, lisible sur un téléphone', () => {
    const mail = accountCreatedWithPassword({
      to: 'fatoumata@lebercail.gn',
      fullName: 'Fatoumata Sylla',
      password: 'Kf3mPq7xW2!',
      loginUrl: 'http://localhost:5173/login',
      role: 'administrateur',
    });

    // Le libellé doit surmonter sa valeur, pas la côtoyer : à 360 px, deux
    // cellules côte à côte se chevauchent, et les media queries ne sont pas
    // fiables sur Gmail Android.
    expect(mail.html).toMatch(
      /Identifiant<\/div>\s*<div[^>]*>[\s\S]*?fatoumata@lebercail\.gn/,
    );
    expect(mail.html).toMatch(
      /Mot de passe provisoire<\/div>\s*<div[^>]*>\s*Kf3mPq7xW2!/,
    );

    // Un alignement à droite trahirait un retour à la mise en page en
    // colonnes qui cassait l'affichage.
    expect(mail.html).not.toContain('text-align:right');

    expect(mail.html).toContain('name="viewport"');
    // Un mot de passe sans espace doit pouvoir se couper plutôt que déborder.
    expect(mail.html).toContain('word-break:break-all');
  });

  it('porte le lien d’activation complet, pas le jeton nu', () => {
    const url =
      'http://localhost:5173/reset-password?mode=activation&token=abc123';
    const mail = accountCreatedWithActivationLink({
      to: 'ibrahima@lebercail.gn',
      fullName: 'Ibrahima Camara',
      activationUrl: url,
      expiresInHours: 72,
      role: 'livreur',
    });

    expect(mail.text).toContain(url);
    expect(mail.html).toContain(`href="${url}"`);
    expect(mail.text).toContain('72 heures');
  });
});
