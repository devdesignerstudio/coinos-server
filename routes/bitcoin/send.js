const btc = config.liquid.btcasset;
const withdrawalFeeMultiplier = 0.01;  // 1% withdrawal fee
const withdrawalFeeReceiver = "coinosfees";  // account that receives the fees

module.exports = ah(async (req, res) => {
  let { user } = req;
  let { address, memo, tx } = req.body;
  let { hex } = tx;

  let fee = toSats(tx.fee);
  if (fee < 0) throw new Error("fee cannot be negative");

  const isChange = async ({ address }) =>
    (await bc.getAddressInfo(address)).ismine &&
    !Object.keys(addresses).includes(address);

  tx = await bc.decodeRawTransaction(hex);

  let total = 0;
  let change = 0;

  console.log("tx.vout is ");
  console.log(tx.vout);

  for (let i = 0; i < tx.vout.length; i++) {
    let o = tx.vout[i];
    total += toSats(o.value);

    console.log(o.scriptPubKey.addresses[0]);

    // if (await isChange("bcrt1q3y0af2vezj4w66zw397hmrglf4pk38pet3wr8g")) {
    //   change += toSats(o.value);
    // }
  }

  total = total - change + fee;
  let amount = total - fee;

  // get withdrawal fee
  // 'total' refers to the total before the withdrawal fee
  // (i.e. the total bitcoin that leaves this server)
  let withdrawalFee = amount * withdrawalFeeMultiplier;

  let account, params;
  try {
    // withdraw bitcoin
    await db.transaction(async transaction => {
      account = await db.Account.findOne({
        where: {
          id: user.account_id
        },
        lock: transaction.LOCK.UPDATE,
        transaction
      });

      if (account.asset !== btc) {
        account = await db.Account.findOne({
          where: {
            user_id: user.id,
            asset: btc,
            pubkey: null
          },
          lock: transaction.LOCK.UPDATE,
          transaction
        });
      }

      console.log("Account balance is " + account.balance);
      console.log("Total is " + total);

      if (total > account.balance) {
        l.error("amount exceeds balance", amount, fee, account.balance);
        throw new Error("low balance");
      } else if (total + withdrawalFee > account.balance) {
        l.error("total (after withdrawal fee) exceeds balance", amount, fee, account.balance);
        throw new Error("low balance (after withdrawal fee)");
      }

      await account.decrement({ balance: (total + withdrawalFee) }, { transaction });
      await account.reload({ transaction });
    });

    // pay withdrawal fee to receiver
    await db.transaction(async transaction => {
      let receiverAccount = await db.Account.findOne({
        where: {
          username: withdrawalFeeReceiver
        },
        lock: transaction.LOCK.UPDATE,
        transaction
      });

      await account.increment({ balance: withdrawalFee }, { transaction });
      await account.reload({ transaction });
    });

    // record the external bitcoin transaction
    // no need to record the withdrawal fee - since that is internal only
    params = {
      amount: -amount,
      fee,
      memo,
      account_id: account.id,
      user_id: user.id,
      rate: app.get("rates")[user.currency],
      currency: user.currency,
      address,
      confirmed: true,
      received: false,
      network: "bitcoin"
    };

    if (config.bitcoin.walletpass)
      await bc.walletPassphrase(config.bitcoin.walletpass, 300);

    hex = (await bc.signRawTransactionWithWallet(hex)).hex;
    params.hash = await bc.sendRawTransaction(hex);

    let payment = await db.Payment.create(params);

    payment = payment.get({ plain: true });
    payment.account = account.get({ plain: true });

    emit(user.username, "payment", payment);
    res.send(payment);

    payments.push(params.hash);
    l.info("sent bitcoin", user.username, total);
  } catch (e) {
    if (e.message.includes("Insufficient")) e.message = "The coinos server hot wallet has insufficient funds to complete the payment, try again later";
    l.error("error sending bitcoin", e.message);
    console.log(e);
    return res.status(500).send(e.message);
  }
});
