import net from "node:net";

// Node prueba IPv6 e IPv4 y abandona cada intento a los 250 ms; con hosts lentos y sin IPv6
// eso termina en ETIMEDOUT aunque la conexión IPv4 llegaría poco después.
net.setDefaultAutoSelectFamilyAttemptTimeout(2000);
