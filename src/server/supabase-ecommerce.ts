import { getServerSupabaseClient, getServiceRoleSupabaseClient } from '../lib/supabase-admin.ts';

function getWriteClient() {
  return getServiceRoleSupabaseClient() || getServerSupabaseClient();
}

function asUuidOrNull(value?: string | null): string | null {
  const clean = String(value || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clean)
    ? clean
    : null;
}

function resolveCustomerCode(customerId?: string, userUid?: string): string {
  if (customerId && customerId.trim()) return customerId.trim();
  if (userUid && userUid.startsWith('NTF-CUST-')) return userUid;
  return '';
}

export async function syncCategoryToSupabase(cat: {
  name: string;
  slug: string;
  storeScope?: string;
  description?: string;
  isActive?: boolean;
  sortOrder?: number;
}) {
  const client = getWriteClient();
  if (!client) return;
  try {
    await client.from('ecommerce_categories').upsert(
      {
        name: cat.name,
        slug: cat.slug,
        store_scope: cat.storeScope || 'general',
        description: cat.description || '',
        is_active: cat.isActive ?? true,
        sort_order: cat.sortOrder ?? 0,
      },
      { onConflict: 'slug' }
    );
  } catch {
    // Non-blocking sync when Supabase schema is not yet applied
  }
}

export async function syncProductToSupabase(prod: {
  sku: string;
  name: string;
  slug: string;
  categorySlug?: string | null;
  brand?: string;
  productType?: string;
  modelNumber?: string;
  shortDescription?: string;
  description?: string;
  technicalSpecs?: Record<string, string>;
  features?: string[];
  applications?: string;
  priceInr: number;
  discountPriceInr?: number | null;
  gstPercent?: number;
  stockQty?: number;
  lowStockThreshold?: number;
  warrantyInfo?: string;
  deliveryInfo?: string;
  imageUrl?: string;
  galleryUrls?: string[];
  availableColors?: string[];
  availableVariants?: string[];
  isFeatured?: boolean;
  isBestseller?: boolean;
  isNewArrival?: boolean;
  isPublished?: boolean;
  isDeleted?: boolean;
  sortOrder?: number;
}) {
  const client = getWriteClient();
  if (!client) return;
  try {
    await client.from('ecommerce_products').upsert(
      {
        sku: prod.sku,
        name: prod.name,
        slug: prod.slug,
        category_slug: prod.categorySlug || null,
        brand: prod.brand || 'NexusTekFusion',
        product_type: prod.productType || 'simple',
        model_number: prod.modelNumber || '',
        short_description: prod.shortDescription || '',
        description: prod.description || '',
        technical_specs: prod.technicalSpecs || {},
        features: prod.features || [],
        applications: prod.applications || '',
        price_inr: prod.priceInr,
        discount_price_inr: prod.discountPriceInr ?? null,
        gst_percent: prod.gstPercent ?? 18,
        stock_qty: prod.stockQty ?? 0,
        low_stock_threshold: prod.lowStockThreshold ?? 5,
        warranty_info: prod.warrantyInfo || '',
        delivery_info: prod.deliveryInfo || '',
        image_url: prod.imageUrl || '',
        gallery_urls: prod.galleryUrls || [],
        available_colors: prod.availableColors || [],
        available_variants: prod.availableVariants || [],
        is_featured: Boolean(prod.isFeatured),
        is_bestseller: Boolean(prod.isBestseller),
        is_new_arrival: Boolean(prod.isNewArrival),
        is_published: prod.isPublished ?? true,
        is_deleted: Boolean(prod.isDeleted),
        sort_order: prod.sortOrder ?? 0,
      },
      { onConflict: 'sku' }
    );
  } catch {
    // Non-blocking sync
  }
}

export async function syncCustomerProfileToSupabase(user: {
  uid: string;
  authUserId?: string | null;
  customerId?: string;
  customerCode?: string;
  email: string;
  fullName: string;
  mobile: string;
  companyOrCollege?: string;
  fullAddress?: string;
  city?: string;
  state?: string;
  pinCode?: string;
  accountStatus?: string;
  role?: string;
  emailVerified?: boolean;
  phoneVerified?: boolean;
  emailConfirmedAt?: string;
  phoneConfirmedAt?: string;
  notificationPreferences?: Record<string, boolean>;
  passwordConfigured?: boolean;
}) {
  const client = getWriteClient();
  if (user.role && user.role !== 'customer') return;
  const profileUuid = asUuidOrNull(user.authUserId) || asUuidOrNull(user.uid);
  if (!client || !profileUuid) {
    return;
  }
  const resolvedCode = user.customerCode || user.customerId || (user.uid.startsWith('NTF-CUST-') ? user.uid : '');
  try {
    const payload: Record<string, unknown> = {
      id: profileUuid,
      email: user.email,
      full_name: user.fullName || '',
      phone: user.mobile || '',
      company_or_college: user.companyOrCollege || '',
      company_name: user.companyOrCollege || '',
      role: user.role || 'customer',
      email_verified: Boolean(user.emailVerified),
      phone_verified: Boolean(user.phoneVerified),
      email_confirmed_at: user.emailConfirmedAt || null,
      phone_confirmed_at: user.phoneConfirmedAt || null,
      updated_at: new Date().toISOString(),
    };
    if (resolvedCode) {
      payload.customer_code = resolvedCode;
      payload.customer_id = resolvedCode;
    }
    if (user.fullAddress !== undefined) payload.full_address = user.fullAddress;
    if (user.city !== undefined) payload.city = user.city;
    if (user.state !== undefined) payload.state = user.state;
    if (user.pinCode !== undefined) payload.pin_code = user.pinCode;
    if (user.accountStatus !== undefined) payload.account_status = user.accountStatus;
    if (user.notificationPreferences !== undefined) {
      payload.notification_preferences = user.notificationPreferences;
    }
    if (user.passwordConfigured !== undefined) {
      payload.password_configured = Boolean(user.passwordConfigured);
    }

    const { error } = await client
      .from('customer_profiles')
      .upsert(payload, { onConflict: 'id' });
    if (error && /column .* does not exist|schema cache/i.test(error.message || '')) {
      await client.from('customer_profiles').upsert(
        {
          id: profileUuid,
          email: user.email,
          full_name: user.fullName || '',
          phone: user.mobile || '',
          role: user.role || 'customer',
        },
        { onConflict: 'id' }
      );
    }
  } catch {
    // Non-blocking sync
  }
}

export async function syncCartToSupabase(
  userUid: string,
  items: Array<{
    productId?: number;
    sku?: string;
    name?: string;
    unitPriceInr?: number;
    qty?: number;
    variant?: string;
    color?: string;
  }>,
  customerCode?: string,
  authUserId?: string | null
) {
  const client = getWriteClient();
  if (!client || !userUid) return;
  const resolvedAuthUid = asUuidOrNull(authUserId) || asUuidOrNull(userUid);
  const resolvedCode = resolveCustomerCode(customerCode, userUid);
  try {
    const nowIso = new Date().toISOString();
    await client.from('customer_carts').upsert(
      {
        user_uid: userUid,
        ...(resolvedAuthUid ? { auth_user_id: resolvedAuthUid } : {}),
        ...(resolvedCode ? { customer_id: resolvedCode } : {}),
        items,
        updated_at: nowIso,
      },
      { onConflict: 'user_uid' }
    );

    const { data: cartRow } = await client
      .from('customer_carts')
      .select('id')
      .eq('user_uid', userUid)
      .maybeSingle();

    if (cartRow?.id) {
      await client.from('customer_cart_items').delete().eq('cart_id', cartRow.id);
      if (items.length > 0) {
        const qtyVal = (it: { qty?: number }) => Math.max(1, Number(it.qty || 1));
        await client.from('customer_cart_items').insert(
          items.map((it) => ({
            cart_id: cartRow.id,
            user_uid: userUid,
            ...(resolvedAuthUid ? { auth_user_id: resolvedAuthUid } : {}),
            customer_id: resolvedCode,
            product_id: Number(it.productId || 0),
            product_sku: String(it.sku || ''),
            product_name: String(it.name || ''),
            variant: String(it.variant || ''),
            color: String(it.color || ''),
            quantity: qtyVal(it),
            qty: qtyVal(it),
            unit_price_inr: Number(it.unitPriceInr || 0),
            updated_at: nowIso,
          }))
        );
      }
    }
  } catch {
    // Non-blocking sync
  }
}

export async function syncStoreOrderToSupabase(order: {
  orderNumber: string;
  userUid: string;
  authUserId?: string | null;
  customerId?: string;
  customerEmail?: string;
  billingAddress: unknown;
  shippingAddress: unknown;
  items: unknown;
  subtotalInr: number;
  discountInr: number;
  shippingInr: number;
  gstInr: number;
  totalInr: number;
  couponCode?: string;
  paymentStatus: string;
  refundStatus?: string;
  orderStatus: string;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  trackingCourier?: string;
  trackingId?: string;
  trackingUrl?: string;
  dispatchDate?: string;
  expectedDeliveryDate?: string;
  statusHistory?: unknown[];
}) {
  const client = getWriteClient();
  if (!client) return;
  const resolvedAuthUid = asUuidOrNull(order.authUserId) || asUuidOrNull(order.userUid);
  const resolvedCode = resolveCustomerCode(order.customerId, order.userUid);
  try {
    const { data: orderRow } = await client
      .from('store_orders')
      .upsert(
        {
          order_number: order.orderNumber,
          user_uid: order.userUid,
          ...(resolvedAuthUid ? { auth_user_id: resolvedAuthUid } : {}),
          ...(resolvedCode ? { customer_id: resolvedCode } : {}),
          customer_email: order.customerEmail || '',
          billing_address: order.billingAddress || {},
          shipping_address: order.shippingAddress || {},
          items: order.items || [],
          subtotal_inr: order.subtotalInr,
          discount_inr: order.discountInr,
          shipping_inr: order.shippingInr,
          gst_inr: order.gstInr,
          total_inr: order.totalInr,
          coupon_code: order.couponCode || '',
          payment_status: order.paymentStatus,
          refund_status: order.refundStatus || 'none',
          order_status: order.orderStatus,
          razorpay_order_id: order.razorpayOrderId || '',
          razorpay_payment_id: order.razorpayPaymentId || '',
          tracking_courier: order.trackingCourier || '',
          tracking_id: order.trackingId || '',
          tracking_url: order.trackingUrl || '',
          dispatch_date: order.dispatchDate || '',
          expected_delivery_date: order.expectedDeliveryDate || '',
          status_history: order.statusHistory || [],
        },
        { onConflict: 'order_number' }
      )
      .select('id')
      .maybeSingle();

    const itemsArr = Array.isArray(order.items) ? (order.items as Array<Record<string, any>>) : [];
    if (itemsArr.length > 0) {
      await client.from('order_items').delete().eq('order_number', order.orderNumber);
      await client.from('order_items').insert(
        itemsArr.map((it) => {
          const qtyVal = Math.max(1, Number(it.qty || 1));
          return {
            ...(orderRow?.id ? { order_id: orderRow.id } : {}),
            order_number: order.orderNumber,
            user_uid: order.userUid,
            ...(resolvedAuthUid ? { auth_user_id: resolvedAuthUid } : {}),
            customer_id: resolvedCode,
            product_id: Number(it.productId || 0),
            product_sku: String(it.sku || ''),
            hsn_code: String(it.hsnCode || ''),
            product_name: String(it.name || ''),
            image_url: String(it.imageUrl || ''),
            variant: String(it.variant || ''),
            color: String(it.color || ''),
            quantity: qtyVal,
            qty: qtyVal,
            unit_price_inr: Number(it.unitPriceInr || 0),
            gst_percent: Number(it.gstPercent ?? 18),
            line_total_inr: Number(it.lineTotalInr || 0),
          };
        })
      );
    }

    await client.from('order_tracking').upsert(
      {
        ...(orderRow?.id ? { order_id: orderRow.id } : {}),
        order_number: order.orderNumber,
        user_uid: order.userUid,
        ...(resolvedAuthUid ? { auth_user_id: resolvedAuthUid } : {}),
        customer_id: resolvedCode,
        current_status: order.orderStatus,
        tracking_courier: order.trackingCourier || '',
        courier_name: order.trackingCourier || '',
        tracking_number: order.trackingId || '',
        tracking_url: order.trackingUrl || '',
        dispatch_date: order.dispatchDate || '',
        estimated_delivery: order.expectedDeliveryDate || '',
        status_history: order.statusHistory || [],
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'order_number' }
    );
  } catch {
    // Non-blocking sync
  }
}

export async function syncPaymentToSupabase(payment: {
  paymentRef: string;
  userUid?: string;
  authUserId?: string | null;
  customerId?: string;
  entityType: string;
  entityRef?: string;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  amountInr: number;
  amountPaise: number;
  mode?: string;
  status: string;
  errorCode?: string;
  failureReason?: string;
  refundStatus?: string;
  refundedAmountInr?: number;
  verifiedAt?: Date | null;
}) {
  const client = getWriteClient();
  if (!client) return;
  const resolvedAuthUid = asUuidOrNull(payment.authUserId) || asUuidOrNull(payment.userUid);
  const resolvedCode = resolveCustomerCode(payment.customerId, payment.userUid);
  try {
    await client.from('razorpay_payments').upsert(
      {
        payment_ref: payment.paymentRef,
        user_uid: payment.userUid || '',
        ...(resolvedAuthUid ? { auth_user_id: resolvedAuthUid } : {}),
        ...(resolvedCode ? { customer_id: resolvedCode } : {}),
        entity_type: payment.entityType,
        entity_ref: payment.entityRef || '',
        razorpay_order_id: payment.razorpayOrderId || '',
        razorpay_payment_id: payment.razorpayPaymentId || null,
        amount_inr: payment.amountInr,
        amount_paise: payment.amountPaise,
        mode: payment.mode || 'test_mode',
        status: payment.status,
        error_code: payment.errorCode || '',
        failure_reason: payment.failureReason || '',
        refund_status: payment.refundStatus || 'none',
        refunded_amount_inr: payment.refundedAmountInr || 0,
        verified_at: payment.verifiedAt ? payment.verifiedAt.toISOString() : null,
      },
      { onConflict: 'payment_ref' }
    );
  } catch {
    // Non-blocking sync
  }
}

export async function syncRefundToSupabase(refund: {
  refundRef: string;
  razorpayPaymentId: string;
  razorpayRefundId?: string;
  amountInr: number;
  amountPaise: number;
  reason?: string;
  status: string;
  initiatedBy?: string;
  processedAt?: Date | null;
}) {
  const client = getWriteClient();
  if (!client) return;
  try {
    await client.from('payment_refunds').upsert(
      {
        refund_ref: refund.refundRef,
        razorpay_payment_id: refund.razorpayPaymentId,
        razorpay_refund_id: refund.razorpayRefundId || null,
        amount_inr: refund.amountInr,
        amount_paise: refund.amountPaise,
        reason: refund.reason || '',
        status: refund.status,
        initiated_by: refund.initiatedBy || '',
        processed_at: refund.processedAt ? refund.processedAt.toISOString() : null,
      },
      { onConflict: 'refund_ref' }
    );
  } catch {
    // Non-blocking sync
  }
}

export async function syncEnquiryToSupabase(enquiry: {
  ticketNumber: string;
  userUid?: string;
  name: string;
  email: string;
  mobile?: string;
  category: string;
  subject: string;
  message: string;
  status: string;
  staffReply?: string;
}) {
  const client = getWriteClient();
  if (!client) return;
  try {
    await client.from('contact_enquiries').upsert(
      {
        ticket_number: enquiry.ticketNumber,
        user_uid: enquiry.userUid || '',
        name: enquiry.name,
        email: enquiry.email,
        mobile: enquiry.mobile || '',
        category: enquiry.category,
        subject: enquiry.subject,
        message: enquiry.message,
        status: enquiry.status,
        staff_reply: enquiry.staffReply || '',
      },
      { onConflict: 'ticket_number' }
    );
  } catch {
    // Non-blocking sync
  }
}

export async function syncProductEnquiryToSupabase(enquiry: {
  enquiryNumber: string;
  userUid?: string;
  fullName: string;
  mobile: string;
  email: string;
  state?: string;
  district?: string;
  organizationOrFarmName?: string;
  interestedProduct: string;
  productSlug?: string;
  quantity?: number;
  intendedApplication?: string;
  message?: string;
  status?: string;
  assignedStaff?: string;
  internalNotes?: string;
}) {
  const client = getWriteClient();
  if (!client) return;
  try {
    await client.from('product_enquiries').upsert(
      {
        enquiry_number: enquiry.enquiryNumber,
        user_uid: enquiry.userUid || '',
        full_name: enquiry.fullName,
        mobile: enquiry.mobile,
        email: enquiry.email,
        state: enquiry.state || '',
        district: enquiry.district || '',
        organization_or_farm_name: enquiry.organizationOrFarmName || '',
        interested_product: enquiry.interestedProduct,
        product_slug: enquiry.productSlug || '',
        quantity: enquiry.quantity ?? 1,
        intended_application: enquiry.intendedApplication || '',
        message: enquiry.message || '',
        status: enquiry.status || 'New',
        assigned_staff: enquiry.assignedStaff || '',
        internal_notes: enquiry.internalNotes || '',
      },
      { onConflict: 'enquiry_number' }
    );
  } catch {
    // Non-blocking sync
  }
}

export async function syncPrintingOrderToSupabase(order: {
  orderNumber: string;
  userUid?: string;
  authUserId?: string | null;
  customerId?: string;
  customerName?: string;
  email?: string;
  phone?: string;
  fileName: string;
  fileFormat: string;
  fileSizeBytes: number;
  fileStoragePath: string;
  storageBucket?: string;
  technology: string;
  materialName: string;
  colorName: string;
  quotedPriceInr?: number | null;
  totalInr: number;
  paymentStatus: string;
  refundStatus?: string;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  orderStatus: string;
  rejectionReason?: string;
  updatedAt?: Date | string;
}) {
  const client = getWriteClient();
  if (!client) return;
  const resolvedUid = order.userUid || order.customerId || '';
  const resolvedAuthUid = asUuidOrNull(order.authUserId) || asUuidOrNull(order.userUid);
  const resolvedCode = resolveCustomerCode(order.customerId, order.userUid);
  try {
    const payload = {
      order_number: order.orderNumber,
      user_uid: resolvedUid,
      ...(resolvedAuthUid ? { auth_user_id: resolvedAuthUid } : {}),
      customer_id: resolvedCode || order.customerId || '',
      customer_name: order.customerName || '',
      email: order.email || '',
      phone: order.phone || '',
      file_name: order.fileName,
      file_format: order.fileFormat,
      file_size: order.fileSizeBytes,
      file_size_bytes: order.fileSizeBytes,
      file_path: order.fileStoragePath,
      file_storage_path: order.fileStoragePath,
      storage_bucket: order.storageBucket || 'printing-files',
      technology: order.technology,
      material_name: order.materialName,
      color_name: order.colorName,
      quoted_price: order.quotedPriceInr ?? order.totalInr,
      total_inr: order.totalInr,
      payment_status: order.paymentStatus,
      refund_status: order.refundStatus || 'none',
      payment_id: order.razorpayPaymentId || '',
      razorpay_order_id: order.razorpayOrderId || '',
      razorpay_payment_id: order.razorpayPaymentId || '',
      order_status: order.orderStatus,
      printing_status: order.orderStatus,
      rejection_reason: order.rejectionReason || '',
      updated_at: new Date().toISOString(),
    };
    const { error } = await client
      .from('printing_orders')
      .upsert(payload, { onConflict: 'order_number' });
    if (error && /column .* does not exist|schema cache/i.test(error.message || '')) {
      await client
        .from('printing_orders')
        .upsert(
          {
            order_number: order.orderNumber,
            file_name: order.fileName,
            file_format: order.fileFormat,
            file_size_bytes: order.fileSizeBytes,
            file_storage_path: order.fileStoragePath,
            storage_bucket: order.storageBucket || 'printing-files',
            total_inr: order.totalInr,
            payment_status: order.paymentStatus,
            refund_status: order.refundStatus || 'none',
            razorpay_order_id: order.razorpayOrderId || '',
            razorpay_payment_id: order.razorpayPaymentId || '',
            order_status: order.orderStatus,
          },
          { onConflict: 'order_number' }
        );
    }

    await client.from('printing_3d_files').upsert(
      {
        order_number: order.orderNumber,
        user_uid: resolvedUid,
        ...(resolvedAuthUid ? { auth_user_id: resolvedAuthUid } : {}),
        customer_id: resolvedCode || order.customerId || '',
        file_name: order.fileName,
        file_format: order.fileFormat,
        file_size_bytes: order.fileSizeBytes,
        storage_bucket: order.storageBucket || 'printing-files',
        storage_path: order.fileStoragePath,
        file_kind: 'original',
      },
      { onConflict: 'order_number,storage_path' }
    );
  } catch {
    // Non-blocking sync
  }
}

export async function deletePrintingOrderFromSupabase(orderNumber: string) {
  const client = getWriteClient();
  if (!client || !orderNumber) return;
  try {
    await client.from('printing_3d_files').delete().eq('order_number', orderNumber);
    await client.from('printing_orders').delete().eq('order_number', orderNumber);
  } catch {
    // Non-blocking delete sync
  }
}

export async function syncCustomerAddressToSupabase(address: {
  sourceAddressId: number;
  userUid: string;
  authUserId?: string | null;
  customerId?: string;
  label?: string;
  addressType?: string;
  fullName: string;
  mobile: string;
  houseFlat: string;
  streetArea: string;
  landmark?: string;
  city: string;
  district?: string;
  state: string;
  pinCode: string;
  country?: string;
  isDefault?: boolean;
}) {
  const client = getWriteClient();
  if (!client || !address.userUid) return;
  const resolvedAuthUid = asUuidOrNull(address.authUserId) || asUuidOrNull(address.userUid);
  const resolvedCode = resolveCustomerCode(address.customerId, address.userUid);
  try {
    if (address.isDefault) {
      await client
        .from('customer_addresses')
        .update({ is_default: false, updated_at: new Date().toISOString() })
        .eq('user_uid', address.userUid);
    }
    await client.from('customer_addresses').upsert(
      {
        source_address_id: address.sourceAddressId,
        local_address_id: address.sourceAddressId,
        user_uid: address.userUid,
        ...(resolvedAuthUid ? { auth_user_id: resolvedAuthUid } : {}),
        customer_id: resolvedCode,
        label: address.label || 'Delivery',
        address_type: address.addressType || 'both',
        full_name: address.fullName,
        mobile: address.mobile,
        phone: address.mobile,
        house_flat: address.houseFlat,
        street_area: address.streetArea,
        address_line: [address.houseFlat, address.streetArea].filter(Boolean).join(', '),
        landmark: address.landmark || '',
        city: address.city,
        district: address.district || '',
        state: address.state,
        pin_code: address.pinCode,
        pincode: address.pinCode,
        country: address.country || 'India',
        is_default: Boolean(address.isDefault),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'source_address_id' }
    );
  } catch {
    // Non-blocking sync
  }
}

export async function deleteCustomerAddressFromSupabase(sourceAddressId: number) {
  const client = getWriteClient();
  if (!client || !sourceAddressId) return;
  try {
    await client.from('customer_addresses').delete().eq('source_address_id', sourceAddressId);
  } catch {
    // Non-blocking sync
  }
}

export async function syncWishlistToSupabase(opts: {
  userUid: string;
  authUserId?: string | null;
  customerId?: string;
  productId: number;
  productSlug?: string;
  productSku?: string;
  wishlisted: boolean;
}) {
  const client = getWriteClient();
  if (!client || !opts.userUid) return;
  const resolvedAuthUid = asUuidOrNull(opts.authUserId) || asUuidOrNull(opts.userUid);
  const resolvedCode = resolveCustomerCode(opts.customerId, opts.userUid);
  try {
    if (opts.wishlisted) {
      await client.from('wishlists').upsert(
        {
          user_uid: opts.userUid,
          ...(resolvedAuthUid ? { auth_user_id: resolvedAuthUid } : {}),
          customer_id: resolvedCode,
          product_id: opts.productId,
          product_slug: opts.productSlug || '',
          product_sku: opts.productSku || '',
        },
        { onConflict: 'user_uid,product_id' }
      );
    } else {
      await client
        .from('wishlists')
        .delete()
        .eq('user_uid', opts.userUid)
        .eq('product_id', opts.productId);
    }
  } catch {
    // Non-blocking sync
  }
}

export async function syncProductReviewToSupabase(review: {
  productId: number;
  productSku?: string;
  userUid: string;
  authUserId?: string | null;
  customerId?: string;
  authorName: string;
  rating: number;
  title?: string;
  comment: string;
  verifiedPurchase?: boolean;
}) {
  const client = getWriteClient();
  if (!client || !review.userUid) return;
  const resolvedAuthUid = asUuidOrNull(review.authUserId) || asUuidOrNull(review.userUid);
  const resolvedCode = resolveCustomerCode(review.customerId, review.userUid);
  try {
    await client.from('product_reviews').insert({
      product_id: review.productId,
      product_sku: review.productSku || '',
      user_uid: review.userUid,
      ...(resolvedAuthUid ? { auth_user_id: resolvedAuthUid } : {}),
      customer_id: resolvedCode,
      author_name: review.authorName,
      rating: review.rating,
      title: review.title || '',
      comment: review.comment,
      verified_purchase: review.verifiedPurchase ?? true,
    });
  } catch {
    // Non-blocking sync
  }
}

export async function syncInvoiceToSupabase(inv: {
  invoiceNumber: string;
  userUid: string;
  authUserId?: string | null;
  customerId?: string;
  orderNumber?: string;
  entityType: string;
  entityId: number;
  docType: string;
  amountInr: number;
  gstInr?: number;
  payload?: Record<string, unknown>;
}) {
  const client = getWriteClient();
  if (!client || !inv.invoiceNumber) return;
  const resolvedAuthUid = asUuidOrNull(inv.authUserId) || asUuidOrNull(inv.userUid);
  const resolvedCode = resolveCustomerCode(inv.customerId, inv.userUid);
  try {
    await client.from('invoices').upsert(
      {
        invoice_number: inv.invoiceNumber,
        user_uid: inv.userUid,
        ...(resolvedAuthUid ? { auth_user_id: resolvedAuthUid } : {}),
        customer_id: resolvedCode,
        order_number: inv.orderNumber || String((inv.payload as any)?.orderNumber || ''),
        entity_type: inv.entityType,
        entity_id: inv.entityId,
        doc_type: inv.docType,
        amount_inr: inv.amountInr,
        gst_inr: inv.gstInr ?? 0,
        payload: inv.payload || {},
      },
      { onConflict: 'invoice_number' }
    );
  } catch {
    // Non-blocking sync
  }
}

export async function syncNotificationToSupabase(notif: {
  userUid: string;
  authUserId?: string | null;
  customerId?: string;
  title: string;
  message: string;
  category?: string;
  type?: string;
  link?: string;
  isRead?: boolean;
}) {
  const client = getWriteClient();
  if (!client || !notif.userUid) return;
  const resolvedAuthUid = asUuidOrNull(notif.authUserId) || asUuidOrNull(notif.userUid);
  const resolvedCode = resolveCustomerCode(notif.customerId, notif.userUid);
  try {
    await client.from('notifications').insert({
      user_uid: notif.userUid,
      ...(resolvedAuthUid ? { auth_user_id: resolvedAuthUid } : {}),
      customer_id: resolvedCode,
      title: notif.title,
      message: notif.message,
      category: notif.category || 'system',
      type: notif.type || 'info',
      link: notif.link || '/my-account',
      is_read: Boolean(notif.isRead),
    });
  } catch {
    // Non-blocking sync
  }
}

export async function syncPcbEnquiryToSupabase(pcb: {
  enquiryNumber: string;
  userUid: string;
  authUserId?: string | null;
  customerId?: string;
  customerName: string;
  email: string;
  mobile: string;
  boardDimensionsMm: string;
  layerCount: number;
  boardQuantity: number;
  assemblyRequired: boolean;
  surfaceFinish?: string;
  specialInstructions?: string;
  attachments?: Array<{ originalName: string; storagePath: string; sizeBytes: number }>;
  quotedAmountInr?: number | null;
  paymentStatus?: string;
  status: string;
}) {
  const client = getWriteClient();
  if (!client || !pcb.enquiryNumber) return;
  const resolvedAuthUid = asUuidOrNull(pcb.authUserId) || asUuidOrNull(pcb.userUid);
  const resolvedCode = resolveCustomerCode(pcb.customerId, pcb.userUid);
  try {
    const { data: pcbRow } = await client
      .from('pcb_enquiries')
      .upsert(
        {
          enquiry_number: pcb.enquiryNumber,
          user_uid: pcb.userUid,
          ...(resolvedAuthUid ? { auth_user_id: resolvedAuthUid } : {}),
          customer_id: resolvedCode,
          customer_name: pcb.customerName,
          email: pcb.email,
          mobile: pcb.mobile,
          board_dimensions_mm: pcb.boardDimensionsMm,
          layer_count: pcb.layerCount,
          board_quantity: pcb.boardQuantity,
          assembly_required: pcb.assemblyRequired,
          surface_finish: pcb.surfaceFinish || 'HASL Lead-Free',
          special_instructions: pcb.specialInstructions || '',
          attachments: pcb.attachments || [],
          quoted_amount_inr: pcb.quotedAmountInr ?? null,
          payment_status: pcb.paymentStatus || 'pending',
          status: pcb.status,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'enquiry_number' }
      )
      .select('id')
      .maybeSingle();

    if (pcb.attachments && pcb.attachments.length > 0) {
      await client.from('pcb_files').delete().eq('enquiry_number', pcb.enquiryNumber);
      await client.from('pcb_files').insert(
        pcb.attachments.map((att) => ({
          ...(pcbRow?.id ? { enquiry_id: pcbRow.id } : {}),
          enquiry_number: pcb.enquiryNumber,
          user_uid: pcb.userUid,
          ...(resolvedAuthUid ? { auth_user_id: resolvedAuthUid } : {}),
          customer_id: resolvedCode,
          file_name: att.originalName,
          file_kind: /\.csv$|\.xlsx$/i.test(att.originalName) ? 'bom' : 'gerber',
          file_size_bytes: att.sizeBytes,
          size_bytes: att.sizeBytes,
          storage_path: att.storagePath,
        }))
      );
    }
  } catch {
    // Non-blocking sync
  }
}

export async function syncB2bEnquiryToSupabase(b2b: {
  enquiryNumber: string;
  userUid: string;
  authUserId?: string | null;
  customerId?: string;
  companyName: string;
  contactPerson: string;
  email: string;
  mobile: string;
  gstin?: string;
  requirementCategory: string;
  quantity: number;
  technicalSpecs: string;
  expectedDeliveryDate?: string;
  shippingLocation: string;
  attachments?: Array<{ originalName: string; storagePath: string; sizeBytes: number }>;
  quotedAmountInr?: number | null;
  paymentStatus?: string;
  status: string;
}) {
  const client = getWriteClient();
  if (!client || !b2b.enquiryNumber) return;
  const resolvedAuthUid = asUuidOrNull(b2b.authUserId) || asUuidOrNull(b2b.userUid);
  const resolvedCode = resolveCustomerCode(b2b.customerId, b2b.userUid);
  try {
    await client.from('b2b_enquiries').upsert(
      {
        enquiry_number: b2b.enquiryNumber,
        user_uid: b2b.userUid,
        ...(resolvedAuthUid ? { auth_user_id: resolvedAuthUid } : {}),
        customer_id: resolvedCode,
        company_name: b2b.companyName,
        contact_person: b2b.contactPerson,
        email: b2b.email,
        mobile: b2b.mobile,
        gstin: b2b.gstin || '',
        requirement_category: b2b.requirementCategory,
        quantity: b2b.quantity,
        technical_specs: b2b.technicalSpecs,
        expected_delivery_date: b2b.expectedDeliveryDate || '',
        shipping_location: b2b.shippingLocation,
        attachments: b2b.attachments || [],
        quoted_amount_inr: b2b.quotedAmountInr ?? null,
        payment_status: b2b.paymentStatus || 'pending',
        status: b2b.status,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'enquiry_number' }
    );
  } catch {
    // Non-blocking sync
  }
}

export async function syncSupportTicketToSupabase(ticket: {
  ticketNumber: string;
  userUid: string;
  authUserId?: string | null;
  customerId?: string;
  subject: string;
  serviceCategory: string;
  status: string;
  messages: Array<{ sender: string; role: string; text: string; timestamp: string }>;
}) {
  const client = getWriteClient();
  if (!client || !ticket.ticketNumber) return;
  const resolvedAuthUid = asUuidOrNull(ticket.authUserId) || asUuidOrNull(ticket.userUid);
  const resolvedCode = resolveCustomerCode(ticket.customerId, ticket.userUid);
  try {
    const { data: ticketRow } = await client
      .from('support_tickets')
      .upsert(
        {
          ticket_number: ticket.ticketNumber,
          user_uid: ticket.userUid,
          ...(resolvedAuthUid ? { auth_user_id: resolvedAuthUid } : {}),
          customer_id: resolvedCode,
          subject: ticket.subject,
          service_category: ticket.serviceCategory,
          status: ticket.status,
          messages: ticket.messages || [],
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'ticket_number' }
      )
      .select('id')
      .maybeSingle();

    if (ticket.messages && ticket.messages.length > 0) {
      await client.from('support_messages').delete().eq('ticket_number', ticket.ticketNumber);
      await client.from('support_messages').insert(
        ticket.messages.map((m) => ({
          ...(ticketRow?.id ? { ticket_id: ticketRow.id } : {}),
          ticket_number: ticket.ticketNumber,
          user_uid: ticket.userUid,
          ...(resolvedAuthUid ? { auth_user_id: resolvedAuthUid } : {}),
          customer_id: resolvedCode,
          sender_name: m.sender,
          sender_role: m.role,
          message_text: m.text,
          message: m.text,
          created_at: m.timestamp || new Date().toISOString(),
        }))
      );
    }
  } catch {
    // Non-blocking sync
  }
}

export async function syncActivityLogToSupabase(entry: {
  userUid: string;
  authUserId?: string | null;
  customerId?: string;
  email?: string;
  action: string;
  entityType?: string;
  entityId?: string;
  details?: Record<string, unknown>;
}) {
  const client = getWriteClient();
  if (!client || !entry.userUid) return;
  const resolvedAuthUid = asUuidOrNull(entry.authUserId) || asUuidOrNull(entry.userUid);
  const resolvedCode = resolveCustomerCode(entry.customerId, entry.userUid);
  try {
    await client.from('customer_activity_logs').insert({
      user_uid: entry.userUid,
      ...(resolvedAuthUid ? { auth_user_id: resolvedAuthUid } : {}),
      customer_id: resolvedCode,
      email: entry.email || '',
      action: entry.action,
      category: entry.entityType || 'account',
      entity_type: entry.entityType || '',
      entity_id: entry.entityId || '',
      details: entry.details || {},
      metadata: entry.details || {},
    });
  } catch {
    // Non-blocking sync
  }
}



