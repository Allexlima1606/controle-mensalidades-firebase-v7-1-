# Controle de Mensalidades PRO v8

Esta versão corrige o login do Firebase.

## O que foi corrigido
- Configuração do Firebase preenchida com o projeto fornecido.
- Erro de JavaScript no `onAuthStateChanged` corrigido (havia `await` dentro de callback não assíncrono).
- Login e criação de conta por e-mail/senha.
- Recuperação de senha.
- LocalStorage + Firestore para sincronização.

## Se o login ainda informar erro
No Firebase Console, confira:
1. Authentication > Sign-in method > E-mail/Senha: habilitado.
2. Firestore Database: criado.
3. Authentication > Settings > Authorized domains: adicione o domínio onde o sistema estiver hospedado.
4. Se abrir como arquivo `file://`, prefira hospedar o sistema em HTTPS (Firebase Hosting, por exemplo).

A API key web do Firebase não é uma senha; a proteção dos dados deve ser feita pelas regras do Firestore e pelo Authentication.
