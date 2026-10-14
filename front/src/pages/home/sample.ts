/* Um XML do MPC Fill pequeno, pros testes: duas cópias de Sol Ring, um
   Delver com verso próprio e um Bolt. */
export const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<order>
  <details><quantity>4</quantity><bracket>18</bracket><stock>(S30) Standard Smooth</stock><foil>false</foil></details>
  <fronts>
    <card><id>solring</id><slots>0,1</slots><name>Sol Ring.png</name><query>sol ring</query></card>
    <card><id>delver</id><slots>2</slots><name>Delver.png</name><query>delver of secrets</query></card>
    <card><id>bolt</id><slots>3</slots><name>Bolt.jpg</name><query>lightning bolt</query></card>
  </fronts>
  <backs>
    <card><id>insectile</id><slots>2</slots><name>Insectile Aberration.png</name><query>insectile aberration</query></card>
  </backs>
  <cardback>verso-padrao</cardback>
</order>`;
